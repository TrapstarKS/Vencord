/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { useTimer } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { moment, PresenceStore, UserStore, VoiceStateStore } from "@webpack/common";

const Text = findComponentByCodeLazy("data-text-variant", "lineClamp");

const lastActive = new Map<string, number>();
const previousStatusMap = new Map<string, string>();
// Timestamp of when a user was last seen active (typing/message/voice) while appearing offline
const invisibleSince = new Map<string, number>();

// How long a momentary invisible signal (typing/message) keeps counting as "active"
const INVISIBLE_TTL = 10 * 60_000;

const settings = definePluginSettings({
    showInDms: {
        type: OptionType.BOOLEAN,
        description: "Show last active in DMs",
        default: true
    },
    showInServers: {
        type: OptionType.BOOLEAN,
        description: "Show last active in server member list",
        default: false
    },
    showInFriendsList: {
        type: OptionType.BOOLEAN,
        description: "Show last active in friends list",
        default: false
    },
    format: {
        type: OptionType.SELECT,
        description: "How to display the last active time",
        options: [
            { label: "Relative — Active 1h ago", value: "relative", default: true },
            { label: "Time — Last active: 15:30", value: "time" },
            { label: "Date + time — Last active: 02/07 15:30", value: "datetime" },
            { label: "Custom (moment.js format)", value: "custom" }
        ]
    },
    customFormat: {
        type: OptionType.STRING,
        description: "moment.js format string used when Format is set to Custom",
        default: "DD/MM HH:mm"
    },
    detectInvisible: {
        type: OptionType.BOOLEAN,
        description: "Try to detect users in invisible mode (they appear offline but are active in voice / typing / sending messages)",
        default: true
    }
}, {
    customFormat: {
        hidden() { return this.store.format !== "custom"; }
    }
});

const isOnline = (s: string) => s !== "offline" && s !== "invisible";

const formatElapsed = (ts: number) => {
    const s = ((Date.now() - ts) / 1000) | 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${(s / 60) | 0}m`;
    if (s < 86400) return `${(s / 3600) | 0}h`;
    return `${(s / 86400) | 0}d`;
};

const formatLabel = (ts: number) => {
    switch (settings.store.format) {
        case "time":
            return `Last active: ${moment(ts).format("LT")}`;
        case "datetime":
            return `Last active: ${moment(ts).format("DD/MM HH:mm")}`;
        case "custom":
            return moment(ts).format(settings.store.customFormat || "DD/MM HH:mm");
        case "relative":
        default:
            return `Active ${formatElapsed(ts)} ago`;
    }
};

function markInvisible(userId?: string) {
    if (!userId || !settings.store.detectInvisible) return;
    if (userId === UserStore.getCurrentUser()?.id) return;
    // Discord reports invisible users as "offline"; being active while offline is the tell
    if (isOnline(PresenceStore.getStatus(userId) ?? "offline")) return;
    const now = Date.now();
    invisibleSince.set(userId, now);
    // Detected activity also refreshes last active, so the elapsed time reflects the real last activity
    lastActive.set(userId, now);
}

function isInVoice(userId: string) {
    return VoiceStateStore.getVoiceStateForUser(userId)?.channelId != null;
}

function isDetectedInvisible(userId: string) {
    if (!settings.store.detectInvisible) return false;
    // Voice is a live, passive signal — always current while they stay in the call
    if (isInVoice(userId) && !isOnline(PresenceStore.getStatus(userId) ?? "offline")) return true;
    const t = invisibleSince.get(userId);
    return t != null && Date.now() - t < INVISIBLE_TTL;
}

function LastActiveText({ user, variant }: { user: User; variant?: string; }) {
    // Forces a re-render every tick so the elapsed time keeps advancing on its own, instead of only
    // updating when the host row happens to re-render for an unrelated reason (e.g. hover).
    useTimer({ interval: 30_000 });

    const invisible = isDetectedInvisible(user.id);
    const ts = lastActive.get(user.id);

    if (!ts && !invisible) return null;

    let body: string;
    if (invisible && isInVoice(user.id))
        body = "active now";
    else if (ts)
        body = formatLabel(ts);
    else
        body = "recently active";

    const title = invisible
        ? "Likely invisible — seen active while appearing offline"
        : (ts ? new Date(ts).toLocaleString() : undefined);

    return (
        <Text variant={variant} color="text-muted" lineClamp={1} title={title}>
            {invisible ? "🫥 " : ""}{body}
        </Text>
    );
}

export default definePlugin({
    name: "LastActive",
    description: "Shows how long ago users were last active",
    authors: [Devs.trapstar],
    settings,

    patches: [
        // DMs
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /(\(0,\i\.\i\)\({[^}]*status:(\i)[^}]*}\)\?\(0,\i\.\i\)\(\i\.\i,\{user:(\i)[^}]*void 0\}\)):(null)/,
                replace: "$1:$self.render($3,$2,'text-xs/medium','dm')"
            }
        },
        // Servers
        {
            find: "#{intl::GUILD_OWNER}),children:",
            replacement: {
                match: /(subText:\s*)(\(\d+,\s*\i\.\i\)\(\i,\s*\{[^}]*status:\s*(\i)[^}]*user:\s*(\i)[^}]*\}\))/,
                replace: "$1$self.render($4,$3,'text-xs/medium','server') || $2"
            }
        },
        // Friends
        {
            find: "null!=this.peopleListItemRef.current",
            replacement: {
                match: /(subText:\s*)(\(\d+,\s*\i\.\i\)\(\i\.\i,\s*\{[^}]*status:\s*(\i)[^}]*user:\s*(\i)[^}]*\}\))/,
                replace: "$1$self.render($4,$3,'text-sm/medium','friends') || $2"
            }
        }
    ],

    flux: {
        PRESENCE_UPDATES({ updates }: { updates: Array<{ user: { id: string; }; status: string; }>; }) {
            for (const { user, status } of updates) {
                const prev = previousStatusMap.get(user.id);

                if (prev !== undefined && isOnline(prev) && !isOnline(status))
                    lastActive.set(user.id, Date.now());
                else if (isOnline(status)) {
                    lastActive.delete(user.id);
                    // They became genuinely visible again — drop any invisible flag
                    invisibleSince.delete(user.id);
                }

                previousStatusMap.set(user.id, status);
            }
        },

        TYPING_START({ userId }: { userId: string; }) {
            markInvisible(userId);
        },

        MESSAGE_CREATE({ message }: { message: { author?: { id: string; }; }; }) {
            markInvisible(message?.author?.id);
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; }>; }) {
            for (const { userId, channelId } of voiceStates) {
                if (channelId) markInvisible(userId);
            }
        }
    },

    start() {
        // Seed initial presences
        const { statuses } = PresenceStore.getState();
        for (const [userId, status] of Object.entries(statuses)) {
            previousStatusMap.set(userId, status as string);
        }
    },

    stop() {
        lastActive.clear();
        previousStatusMap.clear();
        invisibleSince.clear();
    },

    render(user: User, status: string, variant?: string, ctx?: "dm" | "server" | "friends") {
        if (isOnline(status)) return null;

        if (ctx === "dm" && !settings.store.showInDms) return null;
        if (ctx === "server" && !settings.store.showInServers) return null;
        if (ctx === "friends" && !settings.store.showInFriendsList) return null;

        return <LastActiveText user={user} variant={variant} />;
    }
});
