/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { OptionType } from "@utils/types";
import { Button, ChannelStore, Forms, IconUtils, React, TextInput, Toasts, UserStore, useState } from "@webpack/common";

export const settings = definePluginSettings({
    whitelistManager: {
        type: OptionType.COMPONENT,
        description: "Manage who can notify you in DND",
        component: () => <WhitelistManager />,
    },
    whitelistedUserIds: {
        type: OptionType.STRING,
        description: "Advanced: comma-separated user IDs (also edited by the list above)",
        default: "",
    },
    whitelistedGroupChatIds: {
        type: OptionType.STRING,
        description: "Advanced: comma-separated group chat IDs (also edited by the list above)",
        default: "",
    },
    notifyMessages: {
        type: OptionType.BOOLEAN,
        description: "Notify for messages from whitelisted users / group chats while DND",
        default: true,
    },
    notifyCalls: {
        type: OptionType.BOOLEAN,
        description: "Notify for incoming calls from whitelisted users / group chats while DND",
        default: true,
    },
    quietHoursEnabled: {
        type: OptionType.BOOLEAN,
        description: "Suppress DND whitelist notifications during quiet hours",
        default: false,
    },
    quietHoursStart: {
        type: OptionType.STRING,
        description: "Quiet hours start (24h, e.g. 23:00)",
        default: "23:00",
    },
    quietHoursEnd: {
        type: OptionType.STRING,
        description: "Quiet hours end (24h, e.g. 08:00). Can be next morning.",
        default: "08:00",
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
}, {
    quietHoursStart: {
        hidden() {
            return !this.store.quietHoursEnabled;
        }
    },
    quietHoursEnd: {
        hidden() {
            return !this.store.quietHoursEnabled;
        }
    },
});

export function getWhitelist(setting: string): string[] {
    return setting
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}

export function getUserWhitelist(): string[] {
    return getWhitelist(settings.store.whitelistedUserIds);
}

export function getGroupChatWhitelist(): string[] {
    return getWhitelist(settings.store.whitelistedGroupChatIds);
}

export function toggleIdInSetting(settingKey: "whitelistedUserIds" | "whitelistedGroupChatIds", id: string) {
    const list = getWhitelist(settings.store[settingKey]);
    const index = list.indexOf(id);

    if (index === -1) list.push(id);
    else list.splice(index, 1);

    settings.store[settingKey] = list.join(",");
}

/** Parse "HH:mm" or "H:mm" into minutes from midnight; null if invalid. */
export function parseTimeOfDay(value: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

/** True when quiet hours are enabled and the local clock is inside [start, end). */
export function isInQuietHours(now = new Date()): boolean {
    if (!settings.store.quietHoursEnabled) return false;

    const start = parseTimeOfDay(settings.store.quietHoursStart);
    const end = parseTimeOfDay(settings.store.quietHoursEnd);
    if (start == null || end == null || start === end) return false;

    const current = now.getHours() * 60 + now.getMinutes();

    // Overnight window, e.g. 23:00 → 08:00
    if (start > end) return current >= start || current < end;
    return current >= start && current < end;
}

function getUserLabel(userId: string) {
    const user = UserStore.getUser(userId);
    if (!user) return { name: `Unknown (${userId})`, sub: userId, avatar: IconUtils.getDefaultAvatarURL(userId) };

    return {
        name: user.globalName ?? user.username,
        sub: `@${user.username}`,
        avatar: user.getAvatarURL?.(undefined, 40, false) ?? IconUtils.getDefaultAvatarURL(userId)
    };
}

function getGroupLabel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isGroupDM?.()) {
        return {
            name: `Group ${channelId}`,
            sub: channelId,
            avatar: IconUtils.getDefaultAvatarURL(channelId)
        };
    }

    const name = channel.name
        || channel.recipients
            ?.map((id: string) => UserStore.getUser(id)?.globalName ?? UserStore.getUser(id)?.username)
            .filter(Boolean)
            .join(", ")
        || "Group DM";

    const avatar = channel.icon
        ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png?size=40`
        : IconUtils.getDefaultAvatarURL(channelId);

    return { name, sub: channelId, avatar };
}

function WhitelistRow({
    name,
    sub,
    avatar,
    onRemove,
}: {
    name: string;
    sub: string;
    avatar: string;
    onRemove(): void;
}) {
    return (
        <div className="vc-dndwl-row">
            <img className="vc-dndwl-avatar" src={avatar} alt="" aria-hidden="true" />
            <div className="vc-dndwl-info">
                <div className="vc-dndwl-name">{name}</div>
                <div className="vc-dndwl-sub">{sub}</div>
            </div>
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.RED}
                onClick={onRemove}
            >
                Remove
            </Button>
        </div>
    );
}

function WhitelistManager() {
    const [, bump] = useState(0);
    const [userIdDraft, setUserIdDraft] = useState("");
    const [groupIdDraft, setGroupIdDraft] = useState("");

    const refresh = () => bump(n => n + 1);

    const users = getUserWhitelist();
    const groups = getGroupChatWhitelist();

    function addUserId() {
        const id = userIdDraft.trim();
        if (!/^\d{5,32}$/.test(id)) {
            Toasts.show({
                message: "Enter a valid user ID (snowflake).",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }
        if (!getUserWhitelist().includes(id)) {
            toggleIdInSetting("whitelistedUserIds", id);
        }
        setUserIdDraft("");
        refresh();
    }

    function addGroupId() {
        const id = groupIdDraft.trim();
        if (!/^\d{5,32}$/.test(id)) {
            Toasts.show({
                message: "Enter a valid group chat channel ID.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }
        if (!getGroupChatWhitelist().includes(id)) {
            toggleIdInSetting("whitelistedGroupChatIds", id);
        }
        setGroupIdDraft("");
        refresh();
    }

    function sendTestNotification() {
        showNotification({
            title: "DND Whitelist test",
            body: "If you see this, notifications from this plugin are working (even useful to check while DND).",
            useNative: settings.store.nativeNotifications === "default"
                ? undefined
                : settings.store.nativeNotifications as "always" | "not-focused" | "never",
        });
        Toasts.show({
            message: "Test notification sent.",
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS
        });
    }

    return (
        <div className="vc-dndwl-manager">
            <Forms.FormTitle tag="h5">Whitelisted users</Forms.FormTitle>
            <Forms.FormText className="vc-dndwl-help">
                Right-click a user → “Add to DND Whitelist”, or paste an ID below.
            </Forms.FormText>
            {users.length === 0
                ? <Forms.FormText className="vc-dndwl-empty">No users yet.</Forms.FormText>
                : (
                    <div className="vc-dndwl-list">
                        {users.map(id => {
                            const label = getUserLabel(id);
                            return (
                                <WhitelistRow
                                    key={id}
                                    name={label.name}
                                    sub={label.sub}
                                    avatar={label.avatar}
                                    onRemove={() => {
                                        toggleIdInSetting("whitelistedUserIds", id);
                                        refresh();
                                    }}
                                />
                            );
                        })}
                    </div>
                )}
            <Flex className="vc-dndwl-addRow">
                <TextInput
                    value={userIdDraft}
                    onChange={setUserIdDraft}
                    placeholder="User ID"
                    onKeyDown={e => e.key === "Enter" && addUserId()}
                />
                <Button onClick={addUserId} disabled={!userIdDraft.trim()}>Add user</Button>
            </Flex>

            <Forms.FormTitle tag="h5" className="vc-dndwl-sectionTitle">Whitelisted group chats</Forms.FormTitle>
            <Forms.FormText className="vc-dndwl-help">
                Right-click a group DM → “Add Group Chat to DND Whitelist”.
            </Forms.FormText>
            {groups.length === 0
                ? <Forms.FormText className="vc-dndwl-empty">No group chats yet.</Forms.FormText>
                : (
                    <div className="vc-dndwl-list">
                        {groups.map(id => {
                            const label = getGroupLabel(id);
                            return (
                                <WhitelistRow
                                    key={id}
                                    name={label.name}
                                    sub={label.sub}
                                    avatar={label.avatar}
                                    onRemove={() => {
                                        toggleIdInSetting("whitelistedGroupChatIds", id);
                                        refresh();
                                    }}
                                />
                            );
                        })}
                    </div>
                )}
            <Flex className="vc-dndwl-addRow">
                <TextInput
                    value={groupIdDraft}
                    onChange={setGroupIdDraft}
                    placeholder="Group channel ID"
                    onKeyDown={e => e.key === "Enter" && addGroupId()}
                />
                <Button onClick={addGroupId} disabled={!groupIdDraft.trim()}>Add group</Button>
            </Flex>

            <div className="vc-dndwl-testRow">
                <Button color={Button.Colors.TRANSPARENT} onClick={sendTestNotification}>
                    Send test notification
                </Button>
            </div>
        </div>
    );
}
