/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export default definePluginSettings({
    trackImplicitContacts: {
        type: OptionType.BOOLEAN,
        description: "Also track non-friend contacts you frequently interact with (implicit relationships)",
        default: false
    },
    implicitContactLimit: {
        type: OptionType.SLIDER,
        description: "Maximum amount of implicit contacts to track",
        markers: [5, 10, 20, 50, 100],
        default: 20,
        stickToMarkers: true,
        disabled() {
            return !this.store.trackImplicitContacts;
        }
    },
    implicitMinProbability: {
        type: OptionType.SLIDER,
        description: "Minimum communication probability required to track an implicit contact",
        markers: [0, 0.1, 0.25, 0.5, 0.75],
        default: 0.25,
        stickToMarkers: true,
        disabled() {
            return !this.store.trackImplicitContacts;
        }
    },
    scanIntervalMinutes: {
        type: OptionType.SLIDER,
        description: "How often to refresh presence for tracked contacts and run maintenance sweeps",
        markers: [15, 30, 60, 120, 240],
        default: 60,
        stickToMarkers: true
    },
    forcePresenceRefresh: {
        type: OptionType.BOOLEAN,
        description: "Periodically request fresh presence for tracked implicit contacts",
        default: true
    },
    retentionDays: {
        type: OptionType.SLIDER,
        description: "Discard activity data for users not tracked/seen in this many days (0 = never)",
        markers: [30, 90, 180, 365, 0],
        default: 180,
        stickToMarkers: true
    },
    logMessages: {
        type: OptionType.BOOLEAN,
        description: "Store each tracked contact's messages (content, channel, time) so you can browse, search, and jump to them",
        default: true
    },
    messageHistoryLimit: {
        type: OptionType.SLIDER,
        description: "Maximum number of recent messages to keep per contact",
        markers: [100, 250, 500, 1000, 2000],
        default: 1000,
        stickToMarkers: true,
        disabled() {
            return !this.store.logMessages;
        }
    },
    logVoiceCalls: {
        type: OptionType.BOOLEAN,
        description: "Keep a per-contact log of voice calls (channel, time, duration)",
        default: true
    }
});
