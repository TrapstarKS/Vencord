/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { SettingsStore } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { openActivityAnalyticsModal, SettingsAboutComponent } from "./components";
import { rescheduleScanInterval, scheduleVoiceReconciliation, startScanScheduler, stopScanScheduler } from "./scanner";
import settings from "./settings";
import { getTrackedUserIds, invalidateTargetCache } from "./targets";
import { flushAllOpenSessions, loadTracking, onPresenceTransition, onVoiceStateUpdate, recordMessage, seedPresence } from "./tracking";

const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    children.splice(-1, 0,
        <Menu.MenuItem
            id="vc-activity-analytics-open"
            label="View Activity Analytics"
            action={() => openActivityAnalyticsModal(user.id)}
        />
    );
};

/** Recompute the tracked set and open sessions for any user that just entered it. */
function refreshTargets() {
    invalidateTargetCache();
    seedPresence(getTrackedUserIds());
    scheduleVoiceReconciliation(0);
}

// Live-react to setting changes instead of requiring a restart. Cadence changes reschedule the timer;
// implicit-tracking changes recompute the tracked set (which the flux handlers gate on).
const settingsListeners: Array<[path: string, cb: () => void]> = [
    ["plugins.ActivityAnalytics.trackedUserIds", refreshTargets],
    ["plugins.ActivityAnalytics.scanIntervalMinutes", rescheduleScanInterval],
    ["plugins.ActivityAnalytics.trackImplicitContacts", refreshTargets],
    ["plugins.ActivityAnalytics.implicitContactLimit", refreshTargets],
    ["plugins.ActivityAnalytics.implicitMinProbability", refreshTargets]
];

let trackingReady = false;
let pluginLifecycle = 0;
const pendingVoiceStates = new Map<string, { channelId: string | null | undefined; guildId: string | null | undefined; }>();

function normalizeVoiceStates(raw: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(raw)) return raw.filter((state): state is Record<string, unknown> => Boolean(state && typeof state === "object"));
    if (!raw || typeof raw !== "object") return [];

    const state = raw as Record<string, unknown>;
    if ("userId" in state || "user_id" in state) return [state];
    return Object.values(state).filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
}

function readVoiceStateField(state: Record<string, unknown>, camel: string, snake: string) {
    return camel in state ? state[camel] : state[snake];
}

export default definePlugin({
    name: "ActivityAnalytics",
    description: "Tracks presence, voice, and message activity over time for friends and frequent contacts, with a per-person heatmap view.",
    tags: ["Friends", "Activity", "Utility"],
    authors: [Devs.trapstar],
    settings,

    contextMenus: {
        "user-context": userContextMenuPatch
    },

    flux: {
        PRESENCE_UPDATES({ updates }: { updates: Array<{ user: { id: string; }; status: string; }>; }) {
            const trackedIds = getTrackedUserIds();
            for (const { user, status } of updates) {
                if (!trackedIds.has(user.id)) continue;
                onPresenceTransition(user.id, status);
            }
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates?: unknown; }) {
            const trackedIds = getTrackedUserIds();
            for (const state of normalizeVoiceStates(voiceStates)) {
                const userId = readVoiceStateField(state, "userId", "user_id");
                if (typeof userId !== "string" || !trackedIds.has(userId)) continue;

                const channelId = readVoiceStateField(state, "channelId", "channel_id");
                const guildId = readVoiceStateField(state, "guildId", "guild_id");
                const normalizedState = {
                    channelId: typeof channelId === "string" || channelId === null ? channelId : undefined,
                    guildId: typeof guildId === "string" || guildId === null ? guildId : undefined
                };

                if (trackingReady) onVoiceStateUpdate(userId, normalizedState.channelId, normalizedState.guildId);
                else pendingVoiceStates.set(userId, normalizedState);
            }
            scheduleVoiceReconciliation();
        },
        MESSAGE_CREATE({ message }: {
            message: {
                id?: string;
                channel_id?: string;
                guild_id?: string;
                content?: string;
                timestamp?: string;
                attachments?: unknown[];
                author?: { id: string; };
            };
        }) {
            const authorId = message?.author?.id;
            if (!authorId || !message.id || !message.channel_id || !getTrackedUserIds().has(authorId)) return;

            const parsedTs = message.timestamp ? Date.parse(message.timestamp) : NaN;
            recordMessage(authorId, {
                id: message.id,
                channelId: message.channel_id,
                guildId: message.guild_id ?? undefined,
                content: typeof message.content === "string" ? message.content : "",
                timestamp: Number.isNaN(parsedTs) ? Date.now() : parsedTs,
                attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0
            });
        },
        RELATIONSHIP_ADD: refreshTargets,
        RELATIONSHIP_UPDATE: refreshTargets,
        RELATIONSHIP_REMOVE: refreshTargets,
        LOAD_USER_AFFINITIES_V2_SUCCESS: refreshTargets,
        RECEIVE_CHANNEL_AFFINITIES: refreshTargets,
        CONNECTION_OPEN() {
            scheduleVoiceReconciliation(4000);
        },
        CONNECTION_RESUMED() {
            scheduleVoiceReconciliation(4000);
        },
        GUILD_CREATE() {
            scheduleVoiceReconciliation(4000);
        }
    },

    async start() {
        const lifecycle = ++pluginLifecycle;
        await loadTracking();
        if (lifecycle !== pluginLifecycle) return;
        invalidateTargetCache();
        seedPresence(getTrackedUserIds());
        trackingReady = true;
        for (const [userId, state] of pendingVoiceStates) onVoiceStateUpdate(userId, state.channelId, state.guildId);
        pendingVoiceStates.clear();
        startScanScheduler();
        for (const [path, cb] of settingsListeners) SettingsStore.addChangeListener(path, cb);
    },

    async stop() {
        pluginLifecycle++;
        trackingReady = false;
        pendingVoiceStates.clear();
        for (const [path, cb] of settingsListeners) SettingsStore.removeChangeListener(path, cb);
        stopScanScheduler();
        await flushAllOpenSessions();
    },

    settingsAboutComponent: SettingsAboutComponent
});
