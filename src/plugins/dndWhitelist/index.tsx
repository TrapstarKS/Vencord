/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, MessageJSON, User } from "@vencord/discord-types";
import { MessageType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { CallStore, ChannelRouter, ChannelStore, GuildMemberStore, GuildStore, IconUtils, Menu, MessageStore, NotificationSettingsStore, PresenceStore, SelectedChannelStore, StreamerModeStore, UserSettingsProtoStore, UserStore, VoiceStateStore } from "@webpack/common";

type DndWhitelistMessage = MessageJSON & {
    sticker_items?: unknown[];
};

type MessageBodySource = {
    content?: string;
    attachments?: unknown[];
    stickerItems?: unknown[];
    stickers?: unknown[];
    sticker_items?: unknown[];
    embeds?: unknown[];
};

type DndWhitelistCall = {
    channel_id?: string;
    channelId?: string;
    message_id?: string | null;
    messageId?: string | null;
    user_id?: string;
    userId?: string;
    ringing?: string[];
};

type DndWhitelistCallEvent = DndWhitelistCall | {
    call?: DndWhitelistCall;
    channel_id?: string;
    channelId?: string;
};

const MESSAGE_SOUND = "message1";
const CALL_SOUND = "call_ringing";
const CALL_RING_INTERVAL = 5_000;

const SoundModule = findByPropsLazy("playNotificationSound") as { playNotificationSound(sound: string, volume?: number): void; };
const activeCallRings = new Map<string, ReturnType<typeof setInterval>>();
const notifiedCallKeys = new Map<string, string>();
const logger = new Logger("DNDWhitelist");

const settings = definePluginSettings({
    whitelistedUserIds: {
        type: OptionType.STRING,
        description: "Comma-separated User IDs to always notify (even in DND).",
        default: "",
    },
    whitelistedGroupChatIds: {
        type: OptionType.STRING,
        description: "Comma-separated Group Chat IDs to always notify from (even in DND).",
        default: "",
    },
    nativeNotifications: {
        type: OptionType.SELECT,
        description: "Native (outside Discord) notifications for this plugin's alerts",
        options: [
            { label: "Use Vencord's global setting", value: "default", default: true },
            { label: "Always", value: "always" },
            { label: "Only when Discord isn't focused", value: "not-focused" },
            { label: "Never", value: "never" },
        ],
    },
});

function getWhitelist(setting: string): string[] {
    return setting
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}

function getUserWhitelist(): string[] {
    return getWhitelist(settings.store.whitelistedUserIds);
}

function getGroupChatWhitelist(): string[] {
    return getWhitelist(settings.store.whitelistedGroupChatIds);
}

function isUserWhitelisted(userId?: string | null) {
    return Boolean(userId && getUserWhitelist().includes(userId));
}

function isGroupChatWhitelisted(channel?: Channel | null) {
    return Boolean(channel?.isGroupDM?.() && getGroupChatWhitelist().includes(channel.id));
}

function toggleIdInSetting(settingKey: "whitelistedUserIds" | "whitelistedGroupChatIds", id: string) {
    const list = getWhitelist(settings.store[settingKey]);
    const index = list.indexOf(id);

    if (index === -1) list.push(id);
    else list.splice(index, 1);

    settings.store[settingKey] = list.join(",");
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;

    const isWhitelisted = getUserWhitelist().includes(user.id);

    children.splice(-1, 0, (
        <Menu.MenuItem
            id="dnd-whitelist-user"
            label={isWhitelisted ? "Remove from DND Whitelist" : "Add to DND Whitelist"}
            action={() => toggleIdInSetting("whitelistedUserIds", user.id)}
        />
    ));
};

const gdmContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.isGroupDM?.()) return;

    const isWhitelisted = getGroupChatWhitelist().includes(channel.id);

    children.splice(-1, 0, (
        <Menu.MenuItem
            id="dnd-whitelist-groupchat"
            label={isWhitelisted ? "Remove Group Chat from DND Whitelist" : "Add Group Chat to DND Whitelist"}
            action={() => toggleIdInSetting("whitelistedGroupChatIds", channel.id)}
        />
    ));
};

function getStoredMessage(message: DndWhitelistMessage): MessageBodySource | undefined {
    try {
        return MessageStore.getMessage(message.channel_id, message.id);
    } catch {
        return undefined;
    }
}

function getMessageBodySource(message: DndWhitelistMessage): MessageBodySource {
    const storedMessage = getStoredMessage(message);

    return {
        ...message,
        ...storedMessage,
        content: storedMessage?.content || message.content,
        attachments: storedMessage?.attachments ?? message.attachments,
        stickerItems: storedMessage?.stickerItems ?? storedMessage?.stickers ?? message.sticker_items,
        embeds: storedMessage?.embeds ?? message.embeds,
    };
}

function getMessageBody(message: DndWhitelistMessage) {
    const bodySource = getMessageBodySource(message);
    const stickerItems = bodySource.stickerItems ?? bodySource.stickers ?? bodySource.sticker_items;

    if (bodySource.content) return bodySource.content;
    if (bodySource.attachments?.length) return `Sent ${bodySource.attachments.length} attachment${bodySource.attachments.length === 1 ? "" : "s"}`;
    if (stickerItems?.length) return "Sent a sticker";
    if (bodySource.embeds?.length) return "Sent an embed";

    return "Sent a message";
}

function isCurrentUserDnd(currentUserId: string) {
    return (
        UserSettingsProtoStore?.settings?.status?.status?.value === "dnd" ||
        PresenceStore.getStatus(currentUserId) === "dnd"
    );
}

function isStreamerModeActive() {
    return Boolean(StreamerModeStore?.enabled);
}

function getNativeNotificationOverride() {
    const value = settings.store.nativeNotifications;
    return value === "default" ? undefined : value as "always" | "not-focused" | "never";
}

function shouldSuppressSelectedChannel(channelId: string) {
    return (
        channelId === SelectedChannelStore.getChannelId() &&
        document.hasFocus() &&
        !NotificationSettingsStore?.getNotifyMessagesInSelectedChannel?.()
    );
}

function playSound(sound: string) {
    if (typeof SoundModule?.playNotificationSound !== "function") {
        logger.error(`SoundModule.playNotificationSound not found, resolved module keys: ${SoundModule ? Object.keys(SoundModule).join(", ") : "undefined"}`);
        return;
    }

    try {
        SoundModule.playNotificationSound(sound);
    } catch (e) {
        logger.error(`Failed to play sound "${sound}"`, e);
    }
}

function mentionsCurrentUser(message: DndWhitelistMessage, currentUserId: string, guildId?: string) {
    if (message.mentions.some(user => user.id === currentUserId)) return true;
    if (message.mention_everyone) return true;
    if (!guildId || !message.mention_roles.length) return false;

    const roles = GuildMemberStore.getMember(guildId, currentUserId)?.roles;

    return Boolean(roles?.some(roleId => message.mention_roles.includes(roleId)));
}

function shouldNotifyForMessage(message: DndWhitelistMessage) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId || message.author.id === currentUserId) {
        logger.debug("shouldNotifyForMessage: skip - missing currentUserId or self-authored");
        return false;
    }
    if (message.type === MessageType.CALL) {
        logger.debug("shouldNotifyForMessage: skip - message is a call message");
        return false;
    }
    if (isStreamerModeActive()) {
        logger.debug("shouldNotifyForMessage: skip - streamer mode active");
        return false;
    }
    if (!isCurrentUserDnd(currentUserId)) {
        logger.debug("shouldNotifyForMessage: skip - user not DND");
        return false;
    }
    if (shouldSuppressSelectedChannel(message.channel_id)) {
        logger.debug("shouldNotifyForMessage: skip - selected channel suppression");
        return false;
    }

    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = message.guild_id ?? channel?.guild_id;

    let result: boolean;
    if (isUserWhitelisted(message.author.id)) {
        result = !guildId || mentionsCurrentUser(message, currentUserId, guildId);
    } else {
        result = isGroupChatWhitelisted(channel);
    }

    logger.debug(`shouldNotifyForMessage: result=${result}`, { authorId: message.author.id, channelId: message.channel_id });
    return result;
}

function getMessageTitle(message: DndWhitelistMessage, channel?: Channel | null) {
    const authorName = message.author.globalName ?? message.author.username;

    if (channel?.isGroupDM?.()) return `${authorName} in ${getChannelName(channel)}`;

    const guildId = message.guild_id ?? channel?.guild_id;
    const guildName = guildId ? GuildStore.getGuild(guildId)?.name : undefined;

    if (guildName && channel?.name) return `${authorName} (${guildName}, #${channel.name})`;
    if (channel?.name) return `${authorName} (#${channel.name})`;

    return authorName;
}

function getMessageAuthorAvatarUrl(message: DndWhitelistMessage) {
    const cachedUser = UserStore.getUser(message.author.id);
    if (cachedUser?.getAvatarURL) return cachedUser.getAvatarURL(undefined, undefined, false);

    const { author } = message;
    if (author.avatar) {
        const ext = author.avatar.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=128`;
    }

    return IconUtils.getDefaultAvatarURL(author.id, author.discriminator);
}

function notifyMessage(message: DndWhitelistMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);

    showNotification({
        title: getMessageTitle(message, channel),
        body: getMessageBody(message),
        icon: getMessageAuthorAvatarUrl(message),
        onClick: () => ChannelRouter.transitionToChannel(message.channel_id),
        useNative: getNativeNotificationOverride(),
    });

    playSound(MESSAGE_SOUND);
}

function scheduleMessageNotification(message: DndWhitelistMessage) {
    // shouldNotifyForMessage is already checked by the MESSAGE_CREATE handler; the short delay
    // only gives MessageStore time to populate the body (attachments/stickers/embeds), so we
    // don't re-check here (re-checking raced with DND/selected-channel changes).
    setTimeout(() => notifyMessage(message), 100);
}

function getCallFromEvent(event: DndWhitelistCallEvent) {
    return "call" in event && event.call ? event.call : event;
}

function getCallChannelId(call: DndWhitelistCall) {
    return call.channel_id ?? call.channelId;
}

function getCallMessageId(call: DndWhitelistCall) {
    return call.message_id ?? call.messageId;
}

function getCallUserId(call: DndWhitelistCall) {
    return call.user_id ?? call.userId;
}

function getCallMessage(call: DndWhitelistCall) {
    const channelId = getCallChannelId(call);
    const messageId = getCallMessageId(call);

    if (!channelId || !messageId) return;

    try {
        return MessageStore.getMessage(channelId, messageId);
    } catch {
        return undefined;
    }
}

function getCallNotificationKey(channelId: string, call: DndWhitelistCall) {
    return `${channelId}:${getCallMessageId(call) ?? "ring"}`;
}

function getUserDisplayName(userId?: string | null) {
    const user = userId ? UserStore.getUser(userId) : undefined;

    return user?.globalName ?? user?.username;
}

function getUserAvatarUrl(userId?: string | null) {
    return userId ? UserStore.getUser(userId)?.getAvatarURL?.(undefined, undefined, false) : undefined;
}

function getChannelName(channel: Channel) {
    if (channel.name) return channel.name;

    const recipientNames = channel.recipients
        ?.map(recipientId => getUserDisplayName(recipientId))
        .filter(Boolean);

    return recipientNames?.length ? recipientNames.join(", ") : "Group DM";
}

function getCallCallerId(call: DndWhitelistCall, channel: Channel) {
    const eventUserId = getCallUserId(call);
    if (eventUserId) return eventUserId;

    const messageAuthorId = getCallMessage(call)?.author?.id;
    if (messageAuthorId) return messageAuthorId;

    return channel.isDM?.() ? channel.getRecipientId?.() : undefined;
}

function isCallWhitelisted(call: DndWhitelistCall, channel: Channel) {
    const callerId = getCallCallerId(call, channel);

    return isUserWhitelisted(callerId) || isGroupChatWhitelisted(channel);
}

function isCurrentUserAlreadyInCall(channelId: string, currentUserId: string) {
    try {
        return VoiceStateStore.getVoiceStateForUser(currentUserId)?.channelId === channelId;
    } catch {
        return false;
    }
}

function isCallRingingCurrentUser(call: DndWhitelistCall, channelId: string, currentUserId: string) {
    let { ringing } = call;

    try {
        ringing ??= CallStore.getCall(channelId)?.ringing;
    } catch { }

    // An empty ringing array means nobody is being rung (e.g. the call ended / was declined),
    // so only treat a genuinely unknown list (undefined) as "assume it's for us".
    return ringing == null ? true : ringing.includes(currentUserId);
}

function shouldNotifyForCall(call: DndWhitelistCall) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const channelId = getCallChannelId(call);

    if (!currentUserId || !channelId) {
        logger.debug("shouldNotifyForCall: skip - missing currentUserId or channelId", { currentUserId, channelId });
        return false;
    }
    if (isStreamerModeActive()) {
        logger.debug("shouldNotifyForCall: skip - streamer mode active");
        return false;
    }
    if (!isCurrentUserDnd(currentUserId)) {
        logger.debug("shouldNotifyForCall: skip - user not DND");
        return false;
    }
    if (isCurrentUserAlreadyInCall(channelId, currentUserId)) {
        logger.debug("shouldNotifyForCall: skip - current user already has a voice state in this channel (they're calling out or already joined)");
        return false;
    }
    if (!isCallRingingCurrentUser(call, channelId, currentUserId)) {
        logger.debug("shouldNotifyForCall: skip - current user not in ringing list", { ringing: call.ringing });
        return false;
    }

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isPrivate?.()) {
        logger.debug("shouldNotifyForCall: skip - channel not private", { channelId, channelType: channel?.type });
        return false;
    }

    if (getCallCallerId(call, channel) === currentUserId) {
        logger.debug("shouldNotifyForCall: skip - current user is the caller (outgoing call)");
        return false;
    }

    const result = isCallWhitelisted(call, channel);
    logger.debug(`shouldNotifyForCall: result=${result}`, { callerId: getCallCallerId(call, channel) });
    return result;
}

function notifyCall(call: DndWhitelistCall) {
    const channelId = getCallChannelId(call);
    if (!channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const callerId = getCallCallerId(call, channel);
    const callerName = getUserDisplayName(callerId);
    const channelName = getChannelName(channel);
    const body = channel.isGroupDM?.()
        ? `${callerName ? `${callerName} is calling in` : "Incoming call in"} ${channelName}`
        : `${callerName ?? channelName} is calling you`;

    const baseNotification = {
        title: "Incoming call",
        body,
        icon: getUserAvatarUrl(callerId) ?? (channel.icon ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png` : undefined),
        onClick: () => ChannelRouter.transitionToChannel(channelId),
        onClose: () => stopCallRing(channelId),
        permanent: true,
    };

    // Show both the in-app popup and the native OS toast, regardless of focus/the plugin's
    // nativeNotifications setting, so dismissing either one (via its X) silences the ring
    // without having to answer/decline the call itself.
    showNotification({ ...baseNotification, useNative: "never" });
    // noPersist on the native toast so the same incoming call isn't logged twice in the
    // Notification Log (both calls run persistNotification); the in-app one is the canonical entry.
    showNotification({ ...baseNotification, useNative: "always", noPersist: true });
}

function stopCallRing(channelId?: string) {
    if (!channelId) return;

    const intervalId = activeCallRings.get(channelId);
    if (intervalId) {
        clearInterval(intervalId);
        activeCallRings.delete(channelId);
    }

    notifiedCallKeys.delete(channelId);
}

function handleCallEvent(event: DndWhitelistCallEvent) {
    const call = getCallFromEvent(event);
    const channelId = getCallChannelId(call);

    if (!channelId) {
        logger.debug("handleCallEvent: skip - no channelId in event", event);
        return;
    }

    if (!shouldNotifyForCall(call)) {
        logger.debug(`handleCallEvent: shouldNotifyForCall=false, stopping ring for ${channelId}`);
        stopCallRing(channelId);
        return;
    }

    if (!activeCallRings.has(channelId)) {
        logger.debug(`handleCallEvent: starting ring sound for ${channelId}`);
        playSound(CALL_SOUND);
        activeCallRings.set(channelId, setInterval(() => {
            const liveCall = CallStore.getCall(channelId);
            if (!liveCall || !shouldNotifyForCall(liveCall)) {
                logger.debug(`handleCallEvent: ring tick found call no longer valid for ${channelId}, stopping`);
                stopCallRing(channelId);
                return;
            }
            playSound(CALL_SOUND);
        }, CALL_RING_INTERVAL));
    }

    const notificationKey = getCallNotificationKey(channelId, call);
    if (notifiedCallKeys.get(channelId) !== notificationKey) {
        logger.debug(`handleCallEvent: showing notification for ${channelId}, key=${notificationKey}`);
        notifiedCallKeys.set(channelId, notificationKey);
        notifyCall(call);
    } else {
        logger.debug(`handleCallEvent: notification already shown for key=${notificationKey}, skipping`);
    }
}

function clearCallRings() {
    for (const channelId of activeCallRings.keys()) {
        stopCallRing(channelId);
    }
}

export default definePlugin({
    name: "DNDWhitelist",
    description: "Receive notifications from selected users/group chats even in Do Not Disturb.",
    authors: [Devs.trapstar],
    tags: ["Notifications"],
    settings,
    contextMenus: {
        "user-context": userContextMenuPatch,
        "gdm-context": gdmContextMenuPatch,
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: DndWhitelistMessage; optimistic: boolean; }) {
            if (optimistic || !shouldNotifyForMessage(message)) return;

            scheduleMessageNotification(message);
        },
        CALL_CREATE(event: DndWhitelistCallEvent) {
            logger.debug("flux CALL_CREATE", event);
            handleCallEvent(event);
        },
        CALL_UPDATE(event: DndWhitelistCallEvent) {
            logger.debug("flux CALL_UPDATE", event);
            handleCallEvent(event);
        },
        CALL_ENQUEUE_RING(event: DndWhitelistCallEvent) {
            logger.debug("flux CALL_ENQUEUE_RING", event);
            handleCallEvent(event);
        },
        CALL_DELETE(event: DndWhitelistCallEvent) {
            logger.debug("flux CALL_DELETE", event);
            stopCallRing(getCallChannelId(getCallFromEvent(event)));
        },
    },

    start() {
        logger.info("DNDWhitelist plugin started");
    },

    stop: clearCallRings,
});
