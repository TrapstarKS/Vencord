/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as DataStore from "@api/DataStore";
import { getUniqueUsername, openUserProfile } from "@utils/discord";
import { Constants, FluxDispatcher, GuildMemberStore, GuildStore, RelationshipStore, RestAPI, UserStore, UserUtils } from "@webpack/common";

import settings from "./settings";
import { FriendGuildSnapshot } from "./types";
import { GuildAvailabilityStore, notify } from "./utils";

const SCAN_DELAY_MS = 1500;

const friendGuilds = new Map<string, FriendGuildSnapshot>();
const scanQueue: string[] = [];
const queuedScans = new Set<string>();
let scanning = false;
let friendGuildsLoaded = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let hourlyTimer: ReturnType<typeof setInterval> | undefined;

const friendGuildsKey = () => `relationship-notifier-friend-guilds-${UserStore.getCurrentUser().id}`;

export async function loadFriendGuilds() {
    friendGuilds.clear();

    const stored = await DataStore.get<Map<string, FriendGuildSnapshot>>(friendGuildsKey());
    if (stored) {
        for (const [id, snapshot] of stored) friendGuilds.set(id, snapshot);
    }

    // Only allow scans once the persisted baseline is in memory. Otherwise a CONNECTION_OPEN
    // that fires before this load (see index.ts start()) would scan against an empty map,
    // re-seed baselines from a fragile just-logged-in fetch, and persist a partial map over
    // the good one.
    friendGuildsLoaded = true;
    enqueueStaleFriends();
}

async function persistFriendGuilds() {
    await DataStore.set(friendGuildsKey(), friendGuilds);
}

async function fetchMutualGuildIds(userId: string): Promise<string[] | undefined> {
    FluxDispatcher.dispatch({ type: "USER_PROFILE_FETCH_START", userId });

    const { body } = await RestAPI.get({
        url: Constants.Endpoints.USER_PROFILE(userId),
        query: {
            with_mutual_guilds: true,
            with_mutual_friends_count: false
        },
        oldFormErrors: true,
    });

    FluxDispatcher.dispatch({ type: "USER_UPDATE", user: body.user });
    await FluxDispatcher.dispatch({ type: "USER_PROFILE_FETCH_SUCCESS", userProfile: body });

    const mutualGuilds = body.mutual_guilds as Array<{ id: string; }> | undefined;
    // Discord omits mutual_guilds entirely when the friend's privacy hides mutual servers, or
    // when it returns a partial body under rate-limits. Return undefined (not []) so the caller's
    // `newGuildIds !== undefined` guard skips seeding/diffing instead of treating an unknown
    // result as a confirmed "0 mutual servers".
    return Array.isArray(mutualGuilds) ? mutualGuilds.map(({ id }) => id) : undefined;
}

async function diffAndNotify(userId: string, newGuildIds: string[]) {
    const prev = friendGuilds.get(userId);
    // First-ever observation for this friend: only seed the snapshot, never
    // notify on pre-existing state we have no history for.
    if (prev === undefined) return;
    // An empty stored baseline is almost always a bogus seed (privacy-hidden / partial fetch),
    // not a friend who genuinely shared zero servers. Diffing against it would report every
    // long-standing mutual server as "joined", so treat it like a first observation: the caller
    // re-seeds with this fresh list and we notify nothing.
    if (prev.guildIds.length === 0) return;
    if (!settings.store.friendServerChanges) return;

    const me = UserStore.getCurrentUser().id;
    const newSet = new Set(newGuildIds);
    const oldSet = new Set(prev.guildIds);

    const user = await UserUtils.getUser(userId).catch(() => undefined);
    if (!user) return;

    for (const guildId of oldSet) {
        if (newSet.has(guildId)) continue;
        // If we are also no longer a member, this is our own departure,
        // already handled by onGuildDelete – skip to avoid double-firing.
        if (!GuildMemberStore.isMember(guildId, me)) continue;
        if (GuildAvailabilityStore.isUnavailable(guildId)) continue;

        const guild = GuildStore.getGuild(guildId);
        notify(
            `${getUniqueUsername(user)} left ${guild?.name ?? "a server"}, which you no longer have in common.`,
            user.getAvatarURL(undefined, undefined, false),
            () => openUserProfile(user.id)
        );
    }

    for (const guildId of newSet) {
        if (oldSet.has(guildId)) continue;
        // Only notify for servers we were already a member of ourselves.
        if (!GuildMemberStore.isMember(guildId, me)) continue;

        const guild = GuildStore.getGuild(guildId);
        notify(
            `${getUniqueUsername(user)} joined ${guild?.name ?? "a server"}, which you're both in.`,
            user.getAvatarURL(undefined, undefined, false),
            () => openUserProfile(user.id)
        );
    }
}

export function enqueueStaleFriends() {
    // Ignore enqueue requests (e.g. CONNECTION_OPEN) until loadFriendGuilds() has run, so scans
    // never diff against an empty in-memory map.
    if (!friendGuildsLoaded) return;

    const now = Date.now();
    const staleAfterMs = (settings.store.friendServerScanHours ?? 12) * 3600000;

    for (const userId of RelationshipStore.getFriendIDs()) {
        if (now - (friendGuilds.get(userId)?.lastScannedAt ?? 0) <= staleAfterMs) continue;
        if (queuedScans.has(userId)) continue;

        queuedScans.add(userId);
        scanQueue.push(userId);
    }

    scheduleNextScan();
}

function scheduleNextScan() {
    if (scanTimer != null || scanning || scanQueue.length === 0) return;
    scanTimer = setTimeout(processNextScan, SCAN_DELAY_MS);
}

async function processNextScan() {
    scanTimer = undefined;
    if (scanning) return;

    const userId = scanQueue.shift();
    if (userId == null) return;

    queuedScans.delete(userId);
    scanning = true;

    try {
        const newGuildIds = await fetchMutualGuildIds(userId);
        if (newGuildIds !== undefined) {
            const prev = friendGuilds.get(userId);
            // A now-empty result against an existing non-empty baseline is almost certainly the
            // friend hiding mutual servers (or a partial fetch), not them leaving every shared
            // server at once. Don't notify and don't overwrite the good baseline – leave it stale
            // so the next sweep retries.
            if (newGuildIds.length === 0 && prev !== undefined && prev.guildIds.length > 0) return;

            await diffAndNotify(userId, newGuildIds);
            friendGuilds.set(userId, { guildIds: newGuildIds, lastScannedAt: Date.now() });
            await persistFriendGuilds();
        }
    } catch {
        // Leave the snapshot untouched so this friend is retried on the next stale sweep.
    } finally {
        scanning = false;
        scheduleNextScan();
    }
}

export async function removeFriendGuildSnapshot(userId: string) {
    friendGuilds.delete(userId);

    const queueIndex = scanQueue.indexOf(userId);
    if (queueIndex !== -1) scanQueue.splice(queueIndex, 1);
    queuedScans.delete(userId);

    await persistFriendGuilds();
}

export function startHourlyRescan() {
    hourlyTimer ??= setInterval(enqueueStaleFriends, 3600000);
}

export function resetFriendGuildScanState() {
    if (scanTimer != null) {
        clearTimeout(scanTimer);
        scanTimer = undefined;
    }
    if (hourlyTimer != null) {
        clearInterval(hourlyTimer);
        hourlyTimer = undefined;
    }

    scanQueue.length = 0;
    queuedScans.clear();
    scanning = false;
    friendGuildsLoaded = false;
}
