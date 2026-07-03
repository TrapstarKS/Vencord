/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { localStorage } from "@utils/localStorage";
import definePlugin, { OptionType } from "@utils/types";
import { AuthenticationStore, ChannelStore, Constants, RelationshipStore, RestAPI, UserAffinitiesStore, VoiceStateStore } from "@webpack/common";

const FREQUENT = "FREQUENT";
const STORAGE_KEY = "vc-frequentFriends-stats-v1";
const SCAN_DELAY_MS = 1500;

interface FriendStats {
    channelId: string;
    messageCount: number;
    callMs: number;
    lastScannedAt: number;
}

const settings = definePluginSettings({
    limit: {
        type: OptionType.SLIDER,
        description: "Maximum amount of friends to show in the Frequent tab.",
        markers: [5, 10, 15, 20, 25],
        default: 10,
        stickToMarkers: true
    },
    rescanHours: {
        type: OptionType.SLIDER,
        description: "How often to refresh message totals from Discord search.",
        markers: [1, 6, 12, 24, 72, 168],
        default: 24,
        stickToMarkers: true
    },
    callHourWeight: {
        type: OptionType.SLIDER,
        description: "How many messages one hour spent together in voice is worth.",
        markers: [100, 250, 500, 1000, 2000],
        default: 500,
        stickToMarkers: true
    }
});

let cachedKey: string | undefined;
let cachedFrequentFriendIds = new Set<string>();
let statsVersion = 0;
let loadedStats = false;
let scanning = false;
let refreshQueued = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;

const statsByUser = new Map<string, FriendStats>();
const scanQueue: string[] = [];
const queuedScans = new Set<string>();
const activeVoiceSessions = new Map<string, number>();

function getRecipientId(channel: any): string | undefined {
    return channel?.getRecipientId?.()
        ?? channel?.recipients?.[0]
        ?? channel?.rawRecipients?.[0]?.id;
}

function getFriendIdForDmChannel(channelId: string | null | undefined) {
    if (!channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isDM?.() || channel?.isSystemDM?.()) return;

    const userId = getRecipientId(channel);
    return userId != null && RelationshipStore.isFriend(userId) ? userId : undefined;
}

function getDmChannelId(userId: string) {
    return ChannelStore.getDMFromUserId(userId) ?? ChannelStore.getDMChannelFromUserId(userId)?.id;
}

function getDmRecencyRanks() {
    const ranks = new Map<string, number>();

    try {
        ChannelStore.getSortedPrivateChannels()
            .filter(channel => channel?.isDM?.() && !channel?.isSystemDM?.())
            .forEach((channel, index) => {
                const userId = getRecipientId(channel);
                if (userId != null && !ranks.has(userId)) ranks.set(userId, index);
            });
    } catch { }

    return ranks;
}

function getAffinityTieBreaker(userId: string, affinityMap: Map<string, any>) {
    let affinity;
    try {
        affinity = affinityMap.get(userId) ?? UserAffinitiesStore.getUserAffinity?.(userId);
    } catch {
        return 0;
    }

    if (affinity == null) return 0;

    const probabilities = [
        affinity.communicationProbability,
        affinity.dmProbability,
        affinity.vcProbability
    ].filter((value): value is number => Number.isFinite(value));

    const ranks = [
        affinity.communicationRank,
        affinity.dmRank,
        affinity.vcRank
    ].filter((value): value is number => Number.isFinite(value) && value >= 0);

    const probabilityScore = probabilities.length > 0
        ? Math.max(...probabilities)
        : 0;
    const rankScore = ranks.length > 0
        ? 1 / (Math.min(...ranks) + 1)
        : 0;

    return probabilityScore + rankScore;
}

function loadStats() {
    if (loadedStats) return;
    loadedStats = true;

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw) as Record<string, FriendStats>;
        for (const [userId, stats] of Object.entries(parsed)) {
            if (
                typeof stats?.channelId === "string"
                && Number.isFinite(stats.messageCount)
                && Number.isFinite(stats.callMs)
                && Number.isFinite(stats.lastScannedAt)
            ) {
                statsByUser.set(userId, stats);
            }
        }
    } catch { }
}

function saveStats() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(statsByUser)));
    } catch { }
}

function setStats(userId: string, stats: FriendStats) {
    statsByUser.set(userId, stats);
    statsVersion++;
    cachedKey = undefined;
    saveStats();
    RelationshipStore.emitChange();
}

async function fetchMessageCountFromSearchTabs(channelId: string) {
    const res = await RestAPI.post({
        url: "/users/@me/messages/search/tabs",
        body: {
            track_exact_total_hits: true,
            tabs: {
                messages: {
                    sort_by: "timestamp",
                    sort_order: "desc",
                    channel_ids: [channelId],
                    limit: 1
                }
            }
        },
        oldFormErrors: true
    } as Parameters<typeof RestAPI.post>[0]);

    const total = res.body?.tabs?.messages?.total_results;
    return Number.isFinite(total) ? total as number : undefined;
}

async function fetchMessageCountFromChannelSearch(channelId: string) {
    const res = await RestAPI.get({
        url: `/channels/${channelId}/messages/search`,
        query: {
            include_nsfw: true,
            sort_by: "timestamp",
            sort_order: "desc",
            offset: 0
        },
        oldFormErrors: true
    } as Parameters<typeof RestAPI.get>[0]);

    const total = res.body?.total_results;
    return Number.isFinite(total) ? total as number : undefined;
}

async function fetchMessageCount(channelId: string) {
    try {
        const total = await fetchMessageCountFromSearchTabs(channelId);
        if (total != null) return total;
    } catch { }

    try {
        return await fetchMessageCountFromChannelSearch(channelId);
    } catch {
        return undefined;
    }
}

function getLiveCallMs(userId: string) {
    const startedAt = activeVoiceSessions.get(userId);
    return startedAt == null ? 0 : Date.now() - startedAt;
}

function hasRealInteraction(userId: string, stats = statsByUser.get(userId)) {
    const messageCount = stats?.messageCount ?? 0;
    const callMs = (stats?.callMs ?? 0) + getLiveCallMs(userId);
    return messageCount > 0 || callMs > 0;
}

function getPrimaryInteractionScore(userId: string, stats = statsByUser.get(userId)) {
    const messageCount = stats?.messageCount ?? 0;
    const callMs = (stats?.callMs ?? 0) + getLiveCallMs(userId);
    const callScore = (callMs / 3600000) * (settings.store.callHourWeight ?? 500);

    return messageCount + callScore;
}

// Affinity/recency are only meant to break near-ties between friends with
// otherwise-equal real interaction, never to outweigh a real message/call
// difference or let a no-interaction user into the list at all.
const TIEBREAKER_SCALE = 1e-6;

function getFriendScore(userId: string, affinityMap = UserAffinitiesStore.getUserAffinitiesMap?.() ?? new Map<string, any>(), dmRecencyRanks = getDmRecencyRanks()) {
    const stats = statsByUser.get(userId);
    if (!hasRealInteraction(userId, stats)) return 0;

    const primaryScore = getPrimaryInteractionScore(userId, stats);
    const recencyRank = dmRecencyRanks.get(userId);
    const recencyTieBreaker = recencyRank == null ? 0 : 1 / (recencyRank + 1);
    const tieBreaker = getAffinityTieBreaker(userId, affinityMap) + recencyTieBreaker;
    const safeTieBreaker = Number.isFinite(tieBreaker) ? tieBreaker : 0;

    return primaryScore + safeTieBreaker * TIEBREAKER_SCALE;
}

function queueStatsRefresh() {
    if (refreshQueued) return;

    refreshQueued = true;
    setTimeout(() => {
        refreshQueued = false;
        enqueueStaleScans();
    }, 1000);
}

function enqueueStaleScans() {
    loadStats();

    const now = Date.now();
    const staleAfterMs = (settings.store.rescanHours ?? 24) * 3600000;
    const dmRecencyRanks = getDmRecencyRanks();

    const candidates = RelationshipStore.getFriendIDs()
        .map(userId => ({ userId, channelId: getDmChannelId(userId) }))
        .filter((item): item is { userId: string; channelId: string; } => item.channelId != null)
        .filter(({ userId }) => now - (statsByUser.get(userId)?.lastScannedAt ?? 0) > staleAfterMs)
        .sort((a, b) => (dmRecencyRanks.get(a.userId) ?? Infinity) - (dmRecencyRanks.get(b.userId) ?? Infinity));

    for (const { userId } of candidates) {
        if (!queuedScans.has(userId)) {
            queuedScans.add(userId);
            scanQueue.push(userId);
        }
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
        const channelId = getDmChannelId(userId);
        if (channelId == null) return;

        const messageCount = await fetchMessageCount(channelId);
        // On failure (network error / search rate-limit) leave the old stats and lastScannedAt
        // untouched so this friend is retried on the next stale sweep, instead of being marked
        // scanned with a stale/zero count that then sticks for `rescanHours`.
        if (messageCount == null) return;

        const oldStats = statsByUser.get(userId);
        setStats(userId, {
            channelId,
            messageCount,
            callMs: oldStats?.callMs ?? 0,
            lastScannedAt: Date.now()
        });
    } finally {
        scanning = false;
        scheduleNextScan();
    }
}

function finishVoiceSession(userId: string) {
    const startedAt = activeVoiceSessions.get(userId);
    if (startedAt == null) return;

    activeVoiceSessions.delete(userId);

    const oldStats = statsByUser.get(userId);
    setStats(userId, {
        channelId: getDmChannelId(userId) ?? oldStats?.channelId ?? "",
        messageCount: oldStats?.messageCount ?? 0,
        callMs: (oldStats?.callMs ?? 0) + Date.now() - startedAt,
        lastScannedAt: oldStats?.lastScannedAt ?? 0
    });
}

function finishAllVoiceSessions() {
    for (const userId of [...activeVoiceSessions.keys()]) {
        finishVoiceSession(userId);
    }
}

function getCurrentSharedVoiceFriendIds() {
    const myId = AuthenticationStore.getId();
    if (myId == null) return new Set<string>();

    const channelId = VoiceStateStore.getVoiceStateForUser(myId)?.channelId;
    if (channelId == null) return new Set<string>();

    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const friendIds = new Set<string>();

    for (const voiceState of Object.values(voiceStates)) {
        const userId = voiceState?.userId;
        if (typeof userId === "string" && userId !== myId && voiceState?.channelId === channelId && RelationshipStore.isFriend(userId)) {
            friendIds.add(userId);
        }
    }

    return friendIds;
}

function syncActiveVoiceSessions() {
    const activeFriendIds = getCurrentSharedVoiceFriendIds();
    let changed = false;

    for (const userId of [...activeVoiceSessions.keys()]) {
        if (!activeFriendIds.has(userId)) {
            finishVoiceSession(userId);
            changed = true;
        }
    }

    for (const userId of activeFriendIds) {
        if (!activeVoiceSessions.has(userId)) {
            activeVoiceSessions.set(userId, Date.now());
            changed = true;
        }
    }

    if (changed) {
        cachedKey = undefined;
        RelationshipStore.emitChange();
    }
}

function bumpMessageCount(channelId: string) {
    const userId = getFriendIdForDmChannel(channelId);
    if (userId == null) return;

    const oldStats = statsByUser.get(userId);
    setStats(userId, {
        channelId,
        messageCount: (oldStats?.messageCount ?? 0) + 1,
        callMs: oldStats?.callMs ?? 0,
        lastScannedAt: oldStats?.lastScannedAt ?? 0
    });
}

function getFrequentFriendIds() {
    loadStats();
    // queueStatsRefresh() is intentionally NOT called here: this runs from isFrequentFriend/wrapSort
    // during the friends-list render, and scheduling work there mutates module state mid-render.
    // Refreshes are driven by the CONNECTION_OPEN / CHANNEL_CREATE flux handlers and start() instead.

    const limit = settings.store.limit ?? 10;
    const cacheKey = [
        RelationshipStore.getVersion(),
        ChannelStore.getPrivateChannelsVersion(),
        UserAffinitiesStore.getState?.()?.lastFetched ?? 0,
        statsVersion,
        [...activeVoiceSessions.keys()].sort().join(","),
        limit,
        settings.store.callHourWeight
    ].join(":");

    if (cacheKey === cachedKey) return cachedFrequentFriendIds;

    const affinityMap = UserAffinitiesStore.getUserAffinitiesMap?.() ?? new Map<string, any>();
    const dmRecencyRanks = getDmRecencyRanks();
    const scoredFriends = RelationshipStore.getFriendIDs()
        .filter(userId => hasRealInteraction(userId))
        .map(userId => ({
            userId,
            score: getFriendScore(userId, affinityMap, dmRecencyRanks)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    cachedKey = cacheKey;
    cachedFrequentFriendIds = new Set(scoredFriends.map(friend => friend.userId));

    return cachedFrequentFriendIds;
}

export default definePlugin({
    name: "FrequentFriends",
    description: "Restores the Frequent tab in Friends with friends ranked by message totals and voice call time.",
    tags: ["Friends", "Organisation"],
    authors: [Devs.trapstar],
    settings,
    requiresRestart: true,

    patches: [
        {
            find: "#{intl::FRIENDS_ALL_HEADER}",
            replacement: {
                match: /switch\((\i)\)\{case (\i\.\i)\.ONLINE:/,
                replace: 'switch($1){case $2.FREQUENT:return "Frequent Friends - "+arguments[1];case $2.ONLINE:'
            }
        },
        {
            find: "FriendsEmptyState: Invalid empty state",
            replacement: {
                match: /case (\i\.\i)\.ONLINE:(?=(?:case \1\.\i+:)*return (\i)\.SECTION_ONLINE)/,
                replace: "case $1.FREQUENT:$&"
            }
        },
        {
            find: "#{intl::FRIENDS_SECTION_ONLINE}),className:",
            replacement: {
                match: /,{id:(\i\.\i)\.PENDING,show:.+?className:(\i\.\i)(?=\},\{id:)/,
                replace: (rest, sections, className) =>
                    `,{id:${sections}.FREQUENT,show:true,className:${className},content:"Frequent"}${rest}`
            }
        },
        {
            find: '"FriendsStore"',
            replacement: {
                match: /(?<=case (\i\.\i)\.SUGGESTIONS:return \d+===(\i)\.type)/,
                replace: ";case $1.FREQUENT:return $self.isFrequentFriend($2)"
            }
        },
        {
            find: "getRelationshipCounts(){",
            replacement: {
                match: /\}\)\.sortBy\((.+?)\)\.value\(\)/,
                replace: "}).sortBy(row => $self.wrapSort(($1), row)).value()"
            }
        }
    ],

    flux: {
        CONNECTION_OPEN() {
            syncActiveVoiceSessions();
            queueStatsRefresh();
        },
        CHANNEL_CREATE() {
            queueStatsRefresh();
        },
        VOICE_STATE_UPDATES() {
            syncActiveVoiceSessions();
        },
        MESSAGE_CREATE({ message, optimistic }) {
            if (optimistic) return;
            if (message?.channel_id != null) bumpMessageCount(message.channel_id);
        }
    },

    isFrequentFriend(row: any) {
        const userId = row?.user?.id ?? row?.userId;
        return typeof userId === "string" && getFrequentFriendIds().has(userId);
    },

    wrapSort(comparator: Function, row: any) {
        const userId = row?.user?.id ?? row?.userId;
        return typeof userId === "string" && getFrequentFriendIds().has(userId)
            ? -getFriendScore(userId)
            : comparator(row);
    },

    start() {
        Constants.FriendsSections.FREQUENT = FREQUENT;
        loadStats();
        syncActiveVoiceSessions();
        queueStatsRefresh();
    },

    stop() {
        delete Constants.FriendsSections.FREQUENT;
        finishAllVoiceSessions();

        if (scanTimer != null) {
            clearTimeout(scanTimer);
            scanTimer = undefined;
        }

        cachedKey = undefined;
        cachedFrequentFriendIds.clear();
        scanQueue.length = 0;
        queuedScans.clear();
    }
});
