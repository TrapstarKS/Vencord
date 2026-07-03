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
import { rescheduleScanInterval, startScanScheduler, stopScanScheduler } from "./scanner";
import settings from "./settings";
import { getTrackedUserIds, invalidateTargetCache } from "./targets";
import { flushAllOpenSessions, loadTracking, onPresenceTransition, onVoiceStateUpdate, reconcileOpenSessions, recordMessage, seedPresence } from "./tracking";

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
}

// Live-react to setting changes instead of requiring a restart. Cadence changes reschedule the timer;
// implicit-tracking changes recompute the tracked set (which the flux handlers gate on).
const settingsListeners: Array<[path: string, cb: () => void]> = [
    ["plugins.ActivityAnalytics.scanIntervalMinutes", rescheduleScanInterval],
    ["plugins.ActivityAnalytics.trackImplicitContacts", refreshTargets],
    ["plugins.ActivityAnalytics.implicitContactLimit", refreshTargets],
    ["plugins.ActivityAnalytics.implicitMinProbability", refreshTargets]
];

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
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; guildId?: string | null; }>; }) {
            const trackedIds = getTrackedUserIds();
            for (const state of voiceStates) {
                if (!trackedIds.has(state.userId)) continue;
                onVoiceStateUpdate(state.userId, state.channelId, state.guildId);
            }
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
        RELATIONSHIP_REMOVE: invalidateTargetCache,
        CONNECTION_OPEN() {
            reconcileOpenSessions();
            startScanScheduler();
        }
    },

    async start() {
        await loadTracking();
        invalidateTargetCache();
        seedPresence(getTrackedUserIds());
        startScanScheduler();
        for (const [path, cb] of settingsListeners) SettingsStore.addChangeListener(path, cb);
    },

    async stop() {
        for (const [path, cb] of settingsListeners) SettingsStore.removeChangeListener(path, cb);
        stopScanScheduler();
        await flushAllOpenSessions();
    },

    settingsAboutComponent: SettingsAboutComponent
});
