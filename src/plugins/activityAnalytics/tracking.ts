/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PresenceStore, VoiceStateStore } from "@webpack/common";

import settings from "./settings";
import { isFriend } from "./targets";
import { ActivityBucket, emptyBucket, OpenSessions, PresenceState, TrackedMessage, TrackedVoiceCall, UserAggregate, UserSummary } from "./types";

const AGGREGATES_KEY = "activityAnalytics:aggregates:v1";
const SUMMARIES_KEY = "activityAnalytics:summaries:v1";
const OPEN_SESSIONS_KEY = "activityAnalytics:openSessions:v1";
const MESSAGES_KEY = "activityAnalytics:messages:v1";
const VOICE_CALLS_KEY = "activityAnalytics:voiceCalls:v1";

/** Long-running sessions get closed and reopened on this cadence so data survives a crash and
 * whole-bucket attribution skew stays bounded. */
const HEARTBEAT_MS = 30 * 60 * 1000;

const DEFAULT_MESSAGE_LIMIT = 1000;
/** Per-user cap on stored voice-call log entries (kept fixed; message history is user-configurable). */
const VOICE_CALL_LIMIT = 300;

const VALID_PRESENCE: readonly PresenceState[] = ["online", "idle", "dnd", "offline"];

const aggregates = new Map<string, UserAggregate>();
const summaries = new Map<string, UserSummary>();
const openSessions: OpenSessions = { presence: {}, voice: {} };
const messagesByUser = new Map<string, TrackedMessage[]>();
const voiceCallsByUser = new Map<string, TrackedVoiceCall[]>();

let loaded = false;
let persistQueued = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

let version = 0;
const versionListeners = new Set<() => void>();

/** Monotonic counter bumped on every data mutation so an open modal can re-render on live updates. */
export function getVersion(): number {
    return version;
}

export function subscribe(listener: () => void): () => void {
    versionListeners.add(listener);
    return () => versionListeners.delete(listener);
}

function bumpVersion() {
    version++;
    for (const listener of versionListeners) listener();
}

/** Discord emits statuses beyond our four (streaming/invisible/unknown); collapse them so we never
 * write a phantom `${state}Ms` bucket field or silently drop the elapsed time. */
function normalizePresence(status: string | undefined): PresenceState {
    if (status === "streaming") return "online";
    return (VALID_PRESENCE as readonly string[]).includes(status ?? "") ? status as PresenceState : "offline";
}

function bucketKeyFor(ts: number): string {
    const d = new Date(ts);
    return `${d.getDay()}-${d.getHours()}`;
}

function getOrCreateAggregate(userId: string): UserAggregate {
    let agg = aggregates.get(userId);
    if (!agg) {
        agg = { userId, buckets: {}, totals: emptyBucket(), firstTrackedAt: Date.now(), lastUpdatedAt: Date.now() };
        aggregates.set(userId, agg);
    }
    return agg;
}

function getOrCreateSummary(userId: string): UserSummary {
    let summary = summaries.get(userId);
    if (!summary) {
        const agg = getOrCreateAggregate(userId);
        summary = {
            userId,
            totals: agg.totals,
            isFriend: isFriend(userId),
            isImplicit: !isFriend(userId)
        };
        summaries.set(userId, summary);
    }
    return summary;
}

function addToBucket(userId: string, ts: number, field: keyof ActivityBucket, amount: number) {
    if (amount <= 0) return;

    const agg = getOrCreateAggregate(userId);
    const key = bucketKeyFor(ts);
    const bucket = agg.buckets[key] ??= emptyBucket();
    // `?? 0` guards against an unexpected field key ever producing NaN instead of a number.
    bucket[field] = (bucket[field] ?? 0) + amount;
    agg.totals[field] = (agg.totals[field] ?? 0) + amount;
    agg.lastUpdatedAt = Date.now();

    getOrCreateSummary(userId);
    bumpVersion();
    queuePersist();
}

function queuePersist() {
    if (persistQueued) return;
    persistQueued = true;
    persistTimer = setTimeout(() => {
        persistTimer = undefined;
        persistQueued = false;
        persist();
    }, 1000);
}

async function persist() {
    await DataStore.setMany([
        [AGGREGATES_KEY, Object.fromEntries(aggregates)],
        [SUMMARIES_KEY, Object.fromEntries(summaries)],
        [OPEN_SESSIONS_KEY, openSessions],
        [MESSAGES_KEY, Object.fromEntries(messagesByUser)],
        [VOICE_CALLS_KEY, Object.fromEntries(voiceCallsByUser)]
    ]);
}

export async function flushPersist() {
    if (persistTimer != null) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }
    persistQueued = false;
    await persist();
}

export async function loadTracking() {
    if (loaded) return;
    loaded = true;

    const [storedAggregates, storedSummaries, storedOpenSessions, storedMessages, storedVoiceCalls] = await DataStore.getMany([
        AGGREGATES_KEY,
        SUMMARIES_KEY,
        OPEN_SESSIONS_KEY,
        MESSAGES_KEY,
        VOICE_CALLS_KEY
    ]) as [
        Record<string, UserAggregate> | undefined,
        Record<string, UserSummary> | undefined,
        OpenSessions | undefined,
        Record<string, TrackedMessage[]> | undefined,
        Record<string, TrackedVoiceCall[]> | undefined
    ];

    for (const [id, agg] of Object.entries(storedAggregates ?? {})) aggregates.set(id, agg);
    for (const [id, summary] of Object.entries(storedSummaries ?? {})) {
        // Re-link so future bucket writes keep the summary's totals in sync for free.
        summary.totals = aggregates.get(id)?.totals ?? summary.totals;
        summaries.set(id, summary);
    }

    if (storedOpenSessions) {
        Object.assign(openSessions.presence, storedOpenSessions.presence);
        Object.assign(openSessions.voice, storedOpenSessions.voice);
    }

    for (const [id, list] of Object.entries(storedMessages ?? {})) messagesByUser.set(id, list);
    for (const [id, list] of Object.entries(storedVoiceCalls ?? {})) voiceCallsByUser.set(id, list);
}

export function seedPresence(trackedIds: Iterable<string>) {
    const { statuses } = PresenceStore.getState();
    for (const userId of trackedIds) {
        if (openSessions.presence[userId]) continue; // resumed from persisted state already
        const rawStatus = statuses[userId] as string | undefined;
        if (!rawStatus) continue;
        openSessions.presence[userId] = { userId, state: normalizePresence(rawStatus), startedAt: Date.now() };
    }
}

function closePresenceSession(userId: string, endTs: number) {
    const open = openSessions.presence[userId];
    if (!open) return;
    delete openSessions.presence[userId];
    if (endTs > open.startedAt) addToBucket(userId, open.startedAt, `${open.state}Ms` as keyof ActivityBucket, endTs - open.startedAt);
}

export function onPresenceTransition(userId: string, rawState: string) {
    const newState = normalizePresence(rawState);
    const open = openSessions.presence[userId];
    if (open?.state === newState) return;

    if (open) closePresenceSession(userId, Date.now());
    openSessions.presence[userId] = { userId, state: newState, startedAt: Date.now() };

    const summary = getOrCreateSummary(userId);
    summary.lastPresence = newState;
    if (newState === "online") summary.lastSeenOnlineAt = Date.now();
    bumpVersion();
    queuePersist();
}

/** Closes an open voice session, always crediting the elapsed time to the voice bucket. Unless `logCall` is
 * false (heartbeat splits, which must not fragment one call into many log entries), it also appends a
 * voice-call log entry spanning the whole call segment (`callStartedAt` → `endTs`). */
function closeVoiceSession(userId: string, endTs: number, opts?: { logCall?: boolean; approximate?: boolean; }) {
    const open = openSessions.voice[userId];
    if (!open) return;
    delete openSessions.voice[userId];
    if (endTs > open.startedAt) addToBucket(userId, open.startedAt, "voiceMs", endTs - open.startedAt);

    if (opts?.logCall === false) return;
    const callStartedAt = open.callStartedAt ?? open.startedAt;
    if (endTs > callStartedAt) {
        appendVoiceCall(userId, {
            channelId: open.channelId,
            guildId: open.guildId,
            startedAt: callStartedAt,
            endedAt: endTs,
            durationMs: endTs - callStartedAt,
            approximate: opts?.approximate
        });
    }
}

export function onVoiceStateUpdate(userId: string, channelId: string | null | undefined, guildId?: string | null) {
    const open = openSessions.voice[userId];

    if (channelId) {
        if (!open) {
            const now = Date.now();
            openSessions.voice[userId] = { userId, channelId, guildId: guildId ?? undefined, startedAt: now, callStartedAt: now };
            queuePersist();
        } else if (open.channelId !== channelId) {
            // Moved channels: close the log entry for the old channel and start a fresh call segment.
            // The bucket anchor (`startedAt`) is left untouched so voiceMs attribution is unchanged.
            const now = Date.now();
            const callStartedAt = open.callStartedAt ?? open.startedAt;
            if (now > callStartedAt) {
                appendVoiceCall(userId, {
                    channelId: open.channelId,
                    guildId: open.guildId,
                    startedAt: callStartedAt,
                    endedAt: now,
                    durationMs: now - callStartedAt
                });
            }
            open.channelId = channelId;
            open.guildId = guildId ?? undefined;
            open.callStartedAt = now;
            queuePersist();
        }
        return;
    }

    closeVoiceSession(userId, Date.now());
}

/** Records a message from a tracked user: always bumps the aggregate count (for the heatmap), and — when
 * message logging is enabled — appends it to the per-user, newest-first, capped message log for browsing/search. */
export function recordMessage(userId: string, message: TrackedMessage) {
    addToBucket(userId, message.timestamp, "messageCount", 1);

    if (!settings.store.logMessages) return;

    const list = messagesByUser.get(userId) ?? [];
    // Guard against a duplicate MESSAGE_CREATE for the same id (e.g. optimistic + confirmed).
    if (list[0]?.id === message.id) return;

    list.unshift(message);
    const limit = settings.store.messageHistoryLimit ?? DEFAULT_MESSAGE_LIMIT;
    if (list.length > limit) list.length = limit;
    messagesByUser.set(userId, list);

    bumpVersion();
    queuePersist();
}

function appendVoiceCall(userId: string, call: TrackedVoiceCall) {
    if (!settings.store.logVoiceCalls) return;

    const list = voiceCallsByUser.get(userId) ?? [];
    list.unshift(call);
    if (list.length > VOICE_CALL_LIMIT) list.length = VOICE_CALL_LIMIT;
    voiceCallsByUser.set(userId, list);

    bumpVersion();
    queuePersist();
}

/** Reconciles persisted voice sessions against live voice state after a reconnect, in case a leave was missed. */
export function reconcileOpenSessions() {
    const now = Date.now();
    for (const userId of Object.keys(openSessions.voice)) {
        const state = VoiceStateStore.getVoiceStateForUser?.(userId);
        // They left while we were away; log the call but flag its end time as approximate.
        if (!state?.channelId) closeVoiceSession(userId, now, { approximate: true });
    }
    queuePersist();
}

/** Drops (without crediting) open sessions for users no longer tracked. Their intervening presence/voice
 * events were ignored by the flux handlers, so the elapsed time is unreliable and must not be counted.
 * This also stops heartbeatFlush from fabricating activity for them and lets the retention sweep purge them. */
export function pruneUntrackedSessions(trackedIds: Set<string>) {
    let changed = false;
    for (const userId of Object.keys(openSessions.presence)) {
        if (trackedIds.has(userId)) continue;
        delete openSessions.presence[userId];
        changed = true;
    }
    for (const userId of Object.keys(openSessions.voice)) {
        if (trackedIds.has(userId)) continue;
        delete openSessions.voice[userId];
        changed = true;
    }
    if (changed) queuePersist();
}

export function heartbeatFlush() {
    const now = Date.now();

    for (const [userId, open] of Object.entries(openSessions.presence)) {
        if (now - open.startedAt < HEARTBEAT_MS) continue;
        closePresenceSession(userId, now);
        openSessions.presence[userId] = { userId, state: open.state, startedAt: now };
    }

    for (const [userId, open] of Object.entries(openSessions.voice)) {
        if (now - open.startedAt < HEARTBEAT_MS) continue;
        // Split for bucket attribution only; keep the call open in the log by preserving callStartedAt.
        closeVoiceSession(userId, now, { logCall: false });
        openSessions.voice[userId] = { userId, channelId: open.channelId, guildId: open.guildId, startedAt: now, callStartedAt: open.callStartedAt ?? open.startedAt };
    }

    queuePersist();
}

export async function flushAllOpenSessions() {
    const now = Date.now();
    for (const userId of Object.keys(openSessions.presence)) closePresenceSession(userId, now);
    for (const userId of Object.keys(openSessions.voice)) closeVoiceSession(userId, now);
    await flushPersist();
}

export function applyRetentionSweep(trackedIds: Set<string>) {
    const retentionDays = settings.store.retentionDays ?? 180;
    if (!retentionDays) return;

    const cutoff = Date.now() - retentionDays * 86400000;
    for (const [userId, agg] of [...aggregates]) {
        if (trackedIds.has(userId)) continue;
        if (agg.lastUpdatedAt >= cutoff) continue;

        aggregates.delete(userId);
        summaries.delete(userId);
        messagesByUser.delete(userId);
        voiceCallsByUser.delete(userId);
        delete openSessions.presence[userId];
        delete openSessions.voice[userId];
    }

    queuePersist();
}

export function getAllSummaries(): UserSummary[] {
    return [...summaries.values()];
}

export function getAggregate(userId: string): UserAggregate | undefined {
    return aggregates.get(userId);
}

export function getMessages(userId: string): TrackedMessage[] {
    return messagesByUser.get(userId) ?? [];
}

export function getVoiceCalls(userId: string): TrackedVoiceCall[] {
    return voiceCallsByUser.get(userId) ?? [];
}

export function resetTrackingState() {
    aggregates.clear();
    summaries.clear();
    messagesByUser.clear();
    voiceCallsByUser.clear();
    openSessions.presence = {};
    openSessions.voice = {};
    loaded = false;
    persistQueued = false;
    if (persistTimer != null) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
    }
}
