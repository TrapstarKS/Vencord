/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, MessageJSON, User } from "@vencord/discord-types";
import { MessageType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { CallStore, ChannelRouter, ChannelStore, GuildMemberStore, GuildStore, Menu, MessageStore, NotificationSettingsStore, PresenceStore, SelectedChannelStore, UserSettingsProtoStore, UserStore } from "@webpack/common";

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

const SoundModule = findByPropsLazy("playSound") as { playSound(sound: string, volume?: number): void; };
const activeCallRings = new Map<string, ReturnType<typeof setInterval>>();
const notifiedCallKeys = new Map<string, string>();

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

function shouldSuppressSelectedChannel(channelId: string) {
    return (
        channelId === SelectedChannelStore.getChannelId() &&
        document.hasFocus() &&
        !NotificationSettingsStore?.getNotifyMessagesInSelectedChannel?.()
    );
}

function playSound(sound: string) {
    try {
        SoundModule.playSound(sound);
    } catch { }
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
    if (!currentUserId || message.author.id === currentUserId) return false;
    if (message.type === MessageType.CALL) return false;
    if (!isCurrentUserDnd(currentUserId)) return false;
    if (shouldSuppressSelectedChannel(message.channel_id)) return false;

    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = message.guild_id ?? channel?.guild_id;

    if (isUserWhitelisted(message.author.id)) {
        return !guildId || mentionsCurrentUser(message, currentUserId, guildId);
    }

    return isGroupChatWhitelisted(channel);
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

function notifyMessage(message: DndWhitelistMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);
    const author = UserStore.getUser(message.author.id);

    showNotification({
        title: getMessageTitle(message, channel),
        body: getMessageBody(message),
        icon: author?.getAvatarURL?.() ?? undefined,
        onClick: () => ChannelRouter.transitionToChannel(message.channel_id),
    });

    playSound(MESSAGE_SOUND);
}

function scheduleMessageNotification(message: DndWhitelistMessage) {
    setTimeout(() => {
        if (!shouldNotifyForMessage(message)) return;

        notifyMessage(message);
    }, 100);
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

function isCallRingingCurrentUser(call: DndWhitelistCall, channelId: string, currentUserId: string) {
    let { ringing } = call;

    try {
        ringing ??= CallStore.getCall(channelId)?.ringing;
    } catch { }

    return ringing ? ringing.includes(currentUserId) : true;
}

function shouldNotifyForCall(call: DndWhitelistCall) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const channelId = getCallChannelId(call);

    if (!currentUserId || !channelId) return false;
    if (!isCurrentUserDnd(currentUserId)) return false;
    if (!isCallRingingCurrentUser(call, channelId, currentUserId)) return false;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isPrivate?.()) return false;

    return isCallWhitelisted(call, channel);
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

    showNotification({
        title: "Incoming call",
        body,
        icon: getUserAvatarUrl(callerId) ?? (channel.icon ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png` : undefined),
        onClick: () => ChannelRouter.transitionToChannel(channelId),
    });
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

    if (!channelId) return;

    if (!shouldNotifyForCall(call)) {
        stopCallRing(channelId);
        return;
    }

    if (!activeCallRings.has(channelId)) {
        playSound(CALL_SOUND);
        activeCallRings.set(channelId, setInterval(() => playSound(CALL_SOUND), CALL_RING_INTERVAL));
    }

    const notificationKey = getCallNotificationKey(channelId, call);
    if (notifiedCallKeys.get(channelId) !== notificationKey) {
        notifiedCallKeys.set(channelId, notificationKey);
        notifyCall(call);
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
            handleCallEvent(event);
        },
        CALL_UPDATE(event: DndWhitelistCallEvent) {
            handleCallEvent(event);
        },
        CALL_ENQUEUE_RING(event: DndWhitelistCallEvent) {
            handleCallEvent(event);
        },
        CALL_DELETE(event: DndWhitelistCallEvent) {
            stopCallRing(getCallChannelId(getCallFromEvent(event)));
        },
    },

    stop: clearCallRings,
});
