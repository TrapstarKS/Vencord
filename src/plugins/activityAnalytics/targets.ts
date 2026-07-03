/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RelationshipStore, UserAffinitiesStore } from "@webpack/common";

import settings from "./settings";
import { UserAffinity } from "./types";

let cachedTrackedIds: Set<string> | null = null;

export function invalidateTargetCache() {
    cachedTrackedIds = null;
}

export function getFriendIds(): Set<string> {
    return new Set(RelationshipStore.getFriendIDs());
}

export function getImplicitCandidates(): UserAffinity[] {
    const friendIds = getFriendIds();
    const minProbability = settings.store.implicitMinProbability ?? 0.25;
    const affinities: UserAffinity[] = UserAffinitiesStore.getUserAffinities?.() ?? [];

    return affinities
        .filter(a => !friendIds.has(a.otherUserId))
        .filter(a => (a.communicationProbability ?? 0) >= minProbability)
        .sort((a, b) => (a.communicationRank ?? Infinity) - (b.communicationRank ?? Infinity));
}

/** The full set of users ActivityAnalytics should track: all friends, plus (if enabled) top implicit contacts. */
export function getTrackedUserIds(): Set<string> {
    if (cachedTrackedIds) return cachedTrackedIds;

    const ids = getFriendIds();

    if (settings.store.trackImplicitContacts) {
        const limit = settings.store.implicitContactLimit ?? 20;
        for (const affinity of getImplicitCandidates().slice(0, limit)) ids.add(affinity.otherUserId);
    }

    cachedTrackedIds = ids;
    return ids;
}

export function getImplicitTrackedIds(): Set<string> {
    const friendIds = getFriendIds();
    const tracked = getTrackedUserIds();
    const implicitIds = new Set<string>();
    for (const id of tracked) if (!friendIds.has(id)) implicitIds.add(id);
    return implicitIds;
}

export function isFriend(userId: string): boolean {
    return RelationshipStore.isFriend(userId);
}
