/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, GuildMemberStore, GuildStore, UserProfileStore } from "@webpack/common";

import settings from "./settings";
import { getImplicitTrackedIds, getTrackedUserIds } from "./targets";
import { applyRetentionSweep, heartbeatFlush, pruneUntrackedSessions } from "./tracking";

const SCAN_DELAY_MS = 1500;

const presenceRefreshQueue: string[] = [];
const presenceRefreshQueued = new Set<string>();
let presenceScanning = false;
let presenceScanTimer: ReturnType<typeof setTimeout> | undefined;

let intervalTimer: ReturnType<typeof setInterval> | undefined;

function getKnownMutualGuildIds(userId: string) {
    const allGuildIds = Object.keys(GuildStore.getGuilds());
    const cachedGuildIds = allGuildIds.filter(guildId => GuildMemberStore.isMember(guildId, userId));
    const profileGuildIds = UserProfileStore.getMutualGuilds(userId)?.map(({ guild }) => guild.id) ?? [];
    return [...new Set([...cachedGuildIds, ...profileGuildIds])];
}

export function enqueuePresenceRefresh(implicitIds: Iterable<string>) {
    if (!settings.store.forcePresenceRefresh) return;

    for (const userId of implicitIds) {
        if (presenceRefreshQueued.has(userId)) continue;
        presenceRefreshQueued.add(userId);
        presenceRefreshQueue.push(userId);
    }

    scheduleNextPresenceRefresh();
}

function scheduleNextPresenceRefresh() {
    if (presenceScanTimer != null || presenceScanning || presenceRefreshQueue.length === 0) return;
    presenceScanTimer = setTimeout(processNextPresenceRefresh, SCAN_DELAY_MS);
}

function processNextPresenceRefresh() {
    presenceScanTimer = undefined;
    if (presenceScanning) return;

    const userId = presenceRefreshQueue.shift();
    if (userId == null) return;

    presenceRefreshQueued.delete(userId);
    presenceScanning = true;

    try {
        const guildIds = getKnownMutualGuildIds(userId);
        if (guildIds.length) {
            FluxDispatcher.dispatch({
                type: "GUILD_MEMBERS_REQUEST",
                guildIds,
                userIds: [userId],
                presences: true
            });
        }
    } finally {
        presenceScanning = false;
        scheduleNextPresenceRefresh();
    }
}

export function runScanTick() {
    const tracked = getTrackedUserIds();
    enqueuePresenceRefresh(getImplicitTrackedIds());
    pruneUntrackedSessions(tracked);
    applyRetentionSweep(tracked);
    heartbeatFlush();
}

export function startScanScheduler() {
    // Guard the immediate tick too, so start() + CONNECTION_OPEN at cold launch run it only once.
    if (intervalTimer != null) return;
    runScanTick();
    intervalTimer = setInterval(runScanTick, (settings.store.scanIntervalMinutes ?? 60) * 60000);
}

/** Recreates the interval so a changed scanIntervalMinutes takes effect without a restart. */
export function rescheduleScanInterval() {
    if (intervalTimer != null) clearInterval(intervalTimer);
    intervalTimer = setInterval(runScanTick, (settings.store.scanIntervalMinutes ?? 60) * 60000);
}

export function stopScanScheduler() {
    if (intervalTimer != null) {
        clearInterval(intervalTimer);
        intervalTimer = undefined;
    }
    if (presenceScanTimer != null) {
        clearTimeout(presenceScanTimer);
        presenceScanTimer = undefined;
    }

    presenceRefreshQueue.length = 0;
    presenceRefreshQueued.clear();
    presenceScanning = false;
}
