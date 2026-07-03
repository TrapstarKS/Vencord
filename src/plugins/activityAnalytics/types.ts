/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type PresenceState = "online" | "idle" | "dnd" | "offline";

export interface ActivityBucket {
    onlineMs: number;
    idleMs: number;
    dndMs: number;
    offlineMs: number;
    voiceMs: number;
    messageCount: number;
}

/** Key format: `${dayOfWeek 0-6 (local)}-${hourOfDay 0-23 (local)}`, up to 168 entries. */
export type BucketMap = Record<string, ActivityBucket>;

export interface UserAggregate {
    userId: string;
    buckets: BucketMap;
    /** Running sum of all buckets, kept in sync on every write so the UI never has to reduce 168 entries. */
    totals: ActivityBucket;
    firstTrackedAt: number;
    lastUpdatedAt: number;
}

/** Lightweight per-user record for fast overview-list reads without loading the full bucket map. */
export interface UserSummary {
    userId: string;
    lastSeenOnlineAt?: number;
    lastPresence?: PresenceState;
    totals: ActivityBucket;
    isFriend: boolean;
    isImplicit: boolean;
}

export interface OpenPresenceSession {
    userId: string;
    state: PresenceState;
    startedAt: number;
}

export interface OpenVoiceSession {
    userId: string;
    channelId: string;
    guildId?: string;
    startedAt: number;
    /** True start of the current call segment, preserved across heartbeat splits so the voice-call
     * log records one entry per continuous call in a channel rather than one per 30-minute heartbeat. */
    callStartedAt?: number;
}

/** A single message sent by a tracked user, stored newest-first and capped per user to power the
 * message log, search, and jump-to-message features. */
export interface TrackedMessage {
    id: string;
    channelId: string;
    /** Absent for direct messages. */
    guildId?: string;
    content: string;
    timestamp: number;
    attachmentCount?: number;
}

/** A completed voice-call segment for a tracked user (one channel, one continuous stretch), newest-first. */
export interface TrackedVoiceCall {
    channelId: string;
    guildId?: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    /** Timing reconstructed after a reconnect (a leave was missed while offline), so the end time is imprecise. */
    approximate?: boolean;
}

export interface OpenSessions {
    presence: Record<string, OpenPresenceSession>;
    voice: Record<string, OpenVoiceSession>;
}

export interface UserAffinity {
    otherUserId: string;
    isFriend?: boolean;
    dmProbability?: number;
    dmRank?: number;
    vcProbability?: number;
    vcRank?: number;
    serverMessageProbability?: number;
    serverMessageRank?: number;
    communicationProbability?: number;
    communicationRank?: number;
}

export function emptyBucket(): ActivityBucket {
    return { onlineMs: 0, idleMs: 0, dndMs: 0, offlineMs: 0, voiceMs: 0, messageCount: 0 };
}
