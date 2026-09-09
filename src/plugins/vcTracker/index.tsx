/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Camera, Deafened, MicrophoneMuted, ScreenshareIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, ReporterTestable } from "@utils/types";
import type { Channel, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { Button, ChannelStore, ConfirmModal, Forms, GuildMemberStore, GuildStore, IconUtils, Modal, openModal, ScrollerThin, SelectedChannelStore, showToast, Timestamp, Toasts, useEffect, useReducer, UserStore, VoiceStateStore } from "@webpack/common";
import { nanoid } from "nanoid";
import type { JSX, KeyboardEvent } from "react";

type EventType = "snapshot" | "join" | "leave" | "move" | "state-update";
type StatusValue = boolean | string | null | undefined;

interface VoiceStateUpdate {
    userId: string;
    guildId?: string | null;
    channelId?: string | null;
    oldChannelId?: string | null;
    sessionId?: string | null;
    mute?: boolean;
    deaf?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
    selfVideo?: boolean;
    selfStream?: boolean;
    stream?: boolean;
    suppress?: boolean;
    requestToSpeakTimestamp?: string | null;
}

interface EntitySnapshot {
    id: string;
    name?: string;
    iconUrl?: string;
    type?: number;
    guildId?: string;
}

interface UserSnapshot extends EntitySnapshot {
    username?: string;
    globalName?: string;
    tag?: string;
    avatarUrl?: string;
    guildAvatarUrl?: string;
    bot?: boolean;
}

interface VoiceStatusSnapshot {
    sessionId?: string | null;
    serverMute: boolean;
    serverDeaf: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
    muted: boolean;
    deafened: boolean;
    selfVideo: boolean;
    selfStream: boolean;
    stream: boolean;
    suppress: boolean;
    requestToSpeakTimestamp?: string | null;
}

interface StatusChange {
    key: keyof VoiceStatusSnapshot;
    from: StatusValue;
    to: StatusValue;
}

interface ChannelMemberSnapshot {
    user: UserSnapshot;
    voice: VoiceStatusSnapshot;
}

interface SessionSnapshot {
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    nextStartedAt?: number;
    /** True when endedAt/durationMs are a best guess rather than a directly observed transition. */
    approximate?: boolean;
}

interface ActiveVoiceSession {
    userId: string;
    guildId?: string;
    channelId: string;
    startedAt: number;
    lastStatus: VoiceStatusSnapshot;
}

interface TrackedVoiceEvent {
    id: string;
    type: EventType;
    /**
     * "live" events come straight from a VOICE_STATE_UPDATES dispatch. "reconciled" events are
     * reconstructed at startup by comparing the persisted session against the current voice
     * state, so their timing (especially a "leave"'s duration) is only a best guess.
     */
    source: "live" | "reconciled";
    timestamp: number;
    isoTime: string;
    trackedUser: UserSnapshot;
    guild: EntitySnapshot | null;
    channel: EntitySnapshot | null;
    oldChannel: EntitySnapshot | null;
    voice: VoiceStatusSnapshot;
    previousVoice?: VoiceStatusSnapshot;
    changes: StatusChange[];
    session?: SessionSnapshot;
    channelMembers: ChannelMemberSnapshot[];
    /** Total members in the channel before the snapshot cap is applied. */
    channelMemberCount?: number;
    channelMembersTruncated?: boolean;
    oldChannelMembers: ChannelMemberSnapshot[];
    /** Total members in the old channel before the snapshot cap is applied. */
    oldChannelMemberCount?: number;
    oldChannelMembersTruncated?: boolean;
    raw: {
        userId: string;
        guildId?: string;
        channelId?: string;
        oldChannelId?: string;
        sessionId?: string | null;
    };
}

const LOG_KEY = "vcTracker:events:v1";
const ACTIVE_SESSIONS_KEY = "vcTracker:activeSessions:v1";
const logger = new Logger("VcTracker");

/**
 * On a fresh client launch, VoiceStateStore can still be hydrating when the plugin starts, so a
 * user who's actually still in the same call can briefly look like they've left. Waiting this
 * long before trusting an "empty" result avoids logging a false leave immediately followed by a
 * false rejoin for the same ongoing call.
 */
const RECONCILE_RETRY_DELAY_MS = 4000;
/** How often to compare tracked users against VoiceStateStore as a safety net for missed dispatches. */
const VOICE_RECONCILE_INTERVAL_MS = 15_000;
/** Coalesce bursts of VoiceStateStore changes from busy guilds into one small reconciliation pass. */
const VOICE_RECONCILE_DEBOUNCE_MS = 750;
/** Do not turn a temporarily incomplete large-guild store into a false leave immediately. */
const VOICE_STATE_MISSING_GRACE_MS = 45_000;

const settings = definePluginSettings({
    trackedUserIds: {
        type: OptionType.STRING,
        description: "User IDs to track, separated by comma, space, or new line.",
        default: "",
    },
    includeCallMembers: {
        type: OptionType.BOOLEAN,
        description: "Save who is in the voice channel when a tracked event happens.",
        default: true,
    },
    maxCallMembers: {
        type: OptionType.SLIDER,
        description: "Maximum number of call members to save per event (the total count is still kept).",
        markers: [25, 50, 100, 250, 500],
        default: 100,
        stickToMarkers: true,
        disabled() {
            return !this.store.includeCallMembers;
        }
    },
    showChatSummary: {
        type: OptionType.BOOLEAN,
        description: "Also show a short local bot message in the currently selected channel.",
        default: false,
    },
    maxEvents: {
        type: OptionType.SLIDER,
        description: "Maximum amount of events to keep in local history.",
        markers: [100, 250, 500, 1000, 2000],
        default: 500,
        stickToMarkers: true,
    },
});

const statusKeys = [
    "serverMute",
    "serverDeaf",
    "selfMute",
    "selfDeaf",
    "muted",
    "deafened",
    "selfVideo",
    "selfStream",
    "stream",
    "suppress",
    "requestToSpeakTimestamp",
] satisfies Array<keyof VoiceStatusSnapshot>;

const eventMeta: Record<EventType, { label: string; color: string; }> = {
    snapshot: { label: "Snapshot", color: "#5865f2" },
    join: { label: "Joined", color: "#248046" },
    leave: { label: "Left", color: "#da373c" },
    move: { label: "Moved", color: "#e49b0f" },
    "state-update": { label: "Status", color: "#4e5058" },
};

let activeSessions: Record<string, ActiveVoiceSession> = {};
let activeSessionsLoaded = false;
let voiceQueue = Promise.resolve();
let voiceReconcileTimer: ReturnType<typeof setTimeout> | undefined;
let voiceReconcileInterval: ReturnType<typeof setInterval> | undefined;
let voiceBootstrapTimers: ReturnType<typeof setTimeout>[] = [];
let voiceStoreListener: (() => void) | undefined;
let trackerReady = false;
let trackerLifecycle = 0;
const missingVoiceStateSince: Record<string, number> = {};

const logSignals = new Set<() => void>();

function emitLogUpdate() {
    for (const signal of logSignals) signal();
}

function parseUserIds(value?: string) {
    return Array.from(new Set(
        (value ?? "")
            .split(/[,\s]+/)
            .map(id => id.trim())
            .filter(Boolean)
    ));
}

/**
 * Discord's internal voice-state objects normally use camelCase, but a partial gateway/store
 * object can briefly expose snake_case fields while a large guild is hydrating. Normalize both
 * shapes before applying the tracked-user filter so the fallback path cannot miss the user.
 */
function normalizeVoiceState(raw: unknown): VoiceStateUpdate | null {
    if (!raw || typeof raw !== "object") return null;

    const state = raw as Record<string, unknown>;
    const userId = typeof state.userId === "string"
        ? state.userId
        : typeof state.user_id === "string"
            ? state.user_id
            : undefined;

    if (!userId) return null;

    const readVoiceId = (camel: string, snake: string) => {
        const value = camel in state ? state[camel] : state[snake];
        return typeof value === "string" || value === null || value === undefined ? value : undefined;
    };

    return {
        ...state as unknown as VoiceStateUpdate,
        userId,
        guildId: readVoiceId("guildId", "guild_id"),
        channelId: readVoiceId("channelId", "channel_id"),
        oldChannelId: readVoiceId("oldChannelId", "old_channel_id"),
        sessionId: readVoiceId("sessionId", "session_id"),
    };
}

function normalizeVoiceStates(raw: unknown): VoiceStateUpdate[] {
    if (Array.isArray(raw)) return raw.map(normalizeVoiceState).filter((state): state is VoiceStateUpdate => Boolean(state));
    if (!raw || typeof raw !== "object") return [];

    const state = raw as Record<string, unknown>;
    if ("userId" in state || "user_id" in state) {
        const normalized = normalizeVoiceState(state);
        return normalized ? [normalized] : [];
    }

    return Object.values(state)
        .map(normalizeVoiceState)
        .filter((voiceState): voiceState is VoiceStateUpdate => Boolean(voiceState));
}

function getTrackedUserIds() {
    return parseUserIds(settings.store.trackedUserIds);
}

function getUserSnapshot(userId: string, guildId?: string | null): UserSnapshot {
    let user: User | undefined;
    let member: ReturnType<typeof GuildMemberStore.getMember> | undefined;
    let guildAvatarUrl: string | undefined;
    let nick: string | null | undefined;

    // Profile/member enrichment is best-effort. A custom profile or a partially hydrated large
    // guild must never prevent the raw user/channel transition from being logged.
    try {
        user = UserStore.getUser(userId) as User | undefined;
    } catch (error) {
        logger.error(`Failed to resolve user ${userId}`, error);
    }
    try {
        member = guildId ? GuildMemberStore.getMember(guildId, userId) : undefined;
    } catch (error) {
        logger.error(`Failed to resolve guild member ${userId}`, error);
    }
    try {
        guildAvatarUrl = guildId && member?.avatar
            ? IconUtils.getGuildMemberAvatarURLSimple({
                guildId,
                userId,
                avatar: member.avatar,
                canAnimate: true,
                size: 128,
            })
            : undefined;
    } catch (error) {
        logger.error(`Failed to resolve guild avatar ${userId}`, error);
    }
    try {
        nick = guildId ? GuildMemberStore.getNick(guildId, userId) : undefined;
    } catch (error) {
        logger.error(`Failed to resolve guild nickname ${userId}`, error);
    }

    let avatarUrl: string | undefined;
    try {
        avatarUrl = user?.getAvatarURL?.(undefined, 128, true);
    } catch (error) {
        logger.error(`Failed to resolve avatar ${userId}`, error);
    }

    return {
        id: userId,
        name: nick ?? user?.globalName ?? user?.username ?? userId,
        username: user?.username,
        globalName: user?.globalName,
        tag: user?.tag,
        avatarUrl,
        guildAvatarUrl,
        iconUrl: guildAvatarUrl ?? avatarUrl,
        bot: user?.bot,
    };
}

function getGuildSnapshot(guildId?: string | null): EntitySnapshot | null {
    if (!guildId) return null;

    let guild: ReturnType<typeof GuildStore.getGuild> | undefined;
    try {
        guild = GuildStore.getGuild(guildId);
    } catch (error) {
        logger.error(`Failed to resolve guild ${guildId}`, error);
    }

    let iconUrl: string | undefined;
    try {
        iconUrl = guild ? IconUtils.getGuildIconURL({
            id: guild.id,
            icon: guild.icon,
            canAnimate: true,
            size: 64,
        }) : undefined;
    } catch (error) {
        logger.error(`Failed to resolve guild icon ${guildId}`, error);
    }

    return {
        id: guildId,
        name: guild?.name,
        iconUrl,
    };
}

function getChannelDisplayName(channel?: Channel | null) {
    if (!channel) return undefined;
    if (channel.name) return channel.name;

    const recipients = channel.recipients
        ?.map(id => UserStore.getUser(id)?.globalName ?? UserStore.getUser(id)?.username)
        .filter(Boolean);

    return recipients?.length ? recipients.join(", ") : undefined;
}

function getChannelSnapshot(channelId?: string | null): EntitySnapshot | null {
    if (!channelId) return null;

    let channel: Channel | undefined;
    try {
        channel = ChannelStore.getChannel(channelId) as Channel | undefined;
    } catch (error) {
        logger.error(`Failed to resolve channel ${channelId}`, error);
    }

    let iconUrl: string | undefined;
    try {
        iconUrl = channel ? IconUtils.getChannelIconURL({
            id: channel.id,
            icon: channel.icon,
            applicationId: channel.application_id,
            size: 64,
        }) : undefined;
    } catch (error) {
        logger.error(`Failed to resolve channel icon ${channelId}`, error);
    }

    let displayName: string | undefined;
    try {
        displayName = getChannelDisplayName(channel);
    } catch (error) {
        logger.error(`Failed to resolve channel name ${channelId}`, error);
    }

    return {
        id: channelId,
        name: displayName ?? channelId,
        iconUrl,
        type: channel?.type,
        guildId: channel?.guild_id,
    };
}

function getVoiceStatus(state: VoiceStateUpdate): VoiceStatusSnapshot {
    const serverMute = Boolean(state.mute);
    const serverDeaf = Boolean(state.deaf);
    const selfMute = Boolean(state.selfMute);
    const selfDeaf = Boolean(state.selfDeaf);
    const selfStream = Boolean(state.selfStream ?? state.stream);

    return {
        sessionId: state.sessionId,
        serverMute,
        serverDeaf,
        selfMute,
        selfDeaf,
        muted: serverMute || selfMute,
        deafened: serverDeaf || selfDeaf,
        selfVideo: Boolean(state.selfVideo),
        selfStream,
        stream: Boolean(state.stream),
        suppress: Boolean(state.suppress),
        requestToSpeakTimestamp: state.requestToSpeakTimestamp,
    };
}

function statusToVoiceState(userId: string, status: VoiceStatusSnapshot, channelId?: string, guildId?: string): VoiceStateUpdate {
    return {
        userId,
        guildId,
        channelId,
        sessionId: status.sessionId,
        mute: status.serverMute,
        deaf: status.serverDeaf,
        selfMute: status.selfMute,
        selfDeaf: status.selfDeaf,
        selfVideo: status.selfVideo,
        selfStream: status.selfStream,
        stream: status.stream,
        suppress: status.suppress,
        requestToSpeakTimestamp: status.requestToSpeakTimestamp,
    };
}

function getStatusChanges(previous: VoiceStatusSnapshot | undefined, next: VoiceStatusSnapshot): StatusChange[] {
    if (!previous) return [];

    return statusKeys.flatMap(key => (
        previous[key] !== next[key]
            ? [{ key, from: previous[key], to: next[key] }]
            : []
    ));
}

interface ChannelMembersSnapshot {
    members: ChannelMemberSnapshot[];
    total: number;
    truncated: boolean;
}

function getChannelMembers(channelId?: string | null): ChannelMembersSnapshot {
    if (!settings.store.includeCallMembers || !channelId) return { members: [], total: 0, truncated: false };

    try {
        const channel = ChannelStore.getChannel(channelId) as Channel | undefined;
        const guildId = channel?.guild_id;
        const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceStateUpdate> | undefined;
        const entries = Object.entries(voiceStates ?? {});
        const total = entries.length;
        const maxMembers = Math.max(1, settings.store.maxCallMembers ?? 100);

        // Do not resolve every avatar/profile in a huge channel just to save a diagnostic snapshot.
        // The exact total is retained, while the UI receives a bounded preview.
        const members = entries.slice(0, maxMembers)
            .map(([fallbackUserId, rawVoiceState]) => {
                const voiceState = normalizeVoiceState({ ...rawVoiceState, userId: rawVoiceState.userId ?? fallbackUserId });
                if (!voiceState) return null;

                return {
                    user: getUserSnapshot(voiceState.userId, guildId),
                    voice: getVoiceStatus(voiceState),
                };
            })
            .filter((member): member is ChannelMemberSnapshot => Boolean(member))
            .sort((a, b) => (a.user.name ?? a.user.id).localeCompare(b.user.name ?? b.user.id));

        return { members, total, truncated: total > members.length };
    } catch (error) {
        // Member previews are optional metadata. Never let a huge/partial channel prevent the
        // tracked user's core join/move/leave event from being recorded.
        logger.error(`Failed to snapshot channel members for ${channelId}`, error);
        return { members: [], total: 0, truncated: false };
    }
}

function getEventType(state: VoiceStateUpdate, previousSession?: ActiveVoiceSession): EventType | undefined {
    const channelId = state.channelId ?? undefined;
    const oldChannelId = state.oldChannelId ?? previousSession?.channelId;

    if (channelId !== oldChannelId) {
        if (channelId && oldChannelId) return "move";
        if (channelId) return "join";
        if (oldChannelId) return "leave";
    }

    return channelId ? "state-update" : undefined;
}

function buildEvent(state: VoiceStateUpdate, forcedType?: EventType, source: TrackedVoiceEvent["source"] = "live"): { event: TrackedVoiceEvent | null; sessionsChanged: boolean; } {
    const now = Date.now();
    const { userId } = state;
    const previousSession = activeSessions[userId];
    const currentChannelId = state.channelId ?? undefined;
    const oldChannelId = state.oldChannelId ?? (currentChannelId !== previousSession?.channelId ? previousSession?.channelId : undefined);
    const type = forcedType ?? getEventType({ ...state, oldChannelId }, previousSession);

    if (!type) return { event: null, sessionsChanged: false };

    let channel: Channel | undefined;
    let oldChannel: Channel | undefined;
    try {
        channel = currentChannelId ? ChannelStore.getChannel(currentChannelId) as Channel | undefined : undefined;
    } catch (error) {
        logger.error(`Failed to resolve current voice channel ${currentChannelId}`, error);
    }
    try {
        oldChannel = oldChannelId ? ChannelStore.getChannel(oldChannelId) as Channel | undefined : undefined;
    } catch (error) {
        logger.error(`Failed to resolve previous voice channel ${oldChannelId}`, error);
    }
    const guildId = state.guildId ?? channel?.guild_id ?? oldChannel?.guild_id ?? previousSession?.guildId;
    const voice = getVoiceStatus(state);
    const changes = getStatusChanges(previousSession?.lastStatus, voice);

    if (type === "state-update" && !changes.length) {
        return { event: null, sessionsChanged: false };
    }

    let session: SessionSnapshot | undefined;

    switch (type) {
        case "snapshot":
        case "join":
            if (!currentChannelId) return { event: null, sessionsChanged: false };
            activeSessions[userId] = {
                userId,
                guildId: guildId ?? undefined,
                channelId: currentChannelId,
                startedAt: now,
                lastStatus: voice,
            };
            session = { startedAt: now };
            break;
        case "move": {
            if (!currentChannelId) return { event: null, sessionsChanged: false };
            const startedAt = previousSession?.startedAt ?? now;
            activeSessions[userId] = {
                userId,
                guildId: guildId ?? undefined,
                channelId: currentChannelId,
                startedAt: now,
                lastStatus: voice,
            };
            session = {
                startedAt,
                endedAt: now,
                durationMs: now - startedAt,
                nextStartedAt: now,
            };
            break;
        }
        case "leave": {
            const startedAt = previousSession?.startedAt ?? now;
            delete activeSessions[userId];
            session = {
                startedAt,
                endedAt: now,
                durationMs: now - startedAt,
                // A reconciled leave means we only just noticed they're gone after a restart -
                // the real leave time could be anywhere between startedAt and now.
                approximate: source === "reconciled",
            };
            break;
        }
        case "state-update":
            if (!currentChannelId) return { event: null, sessionsChanged: false };
            activeSessions[userId] = {
                userId,
                guildId: guildId ?? undefined,
                channelId: currentChannelId,
                startedAt: previousSession?.startedAt ?? now,
                lastStatus: voice,
            };
            session = { startedAt: activeSessions[userId].startedAt };
            break;
    }

    const channelMembers = type === "state-update"
        ? { members: [], total: 0, truncated: false }
        : getChannelMembers(currentChannelId);
    const oldChannelMembers = oldChannelId && oldChannelId !== currentChannelId
        ? getChannelMembers(oldChannelId)
        : { members: [], total: 0, truncated: false };

    const event: TrackedVoiceEvent = {
        id: nanoid(),
        type,
        source,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        trackedUser: getUserSnapshot(userId, guildId),
        guild: getGuildSnapshot(guildId),
        channel: getChannelSnapshot(currentChannelId),
        oldChannel: getChannelSnapshot(oldChannelId),
        voice,
        previousVoice: previousSession?.lastStatus,
        changes,
        session,
        channelMembers: channelMembers.members,
        channelMemberCount: channelMembers.total,
        channelMembersTruncated: channelMembers.truncated,
        oldChannelMembers: oldChannelMembers.members,
        oldChannelMemberCount: oldChannelMembers.total,
        oldChannelMembersTruncated: oldChannelMembers.truncated,
        raw: {
            userId,
            guildId: guildId ?? undefined,
            channelId: currentChannelId,
            oldChannelId,
            sessionId: state.sessionId,
        },
    };

    return { event, sessionsChanged: true };
}

async function loadActiveSessions() {
    if (activeSessionsLoaded) return;
    activeSessions = await DataStore.get<Record<string, ActiveVoiceSession>>(ACTIVE_SESSIONS_KEY) ?? {};
    activeSessionsLoaded = true;
}

async function saveActiveSessions() {
    await DataStore.set(ACTIVE_SESSIONS_KEY, activeSessions);
}

async function getLogs() {
    return await DataStore.get<TrackedVoiceEvent[]>(LOG_KEY) ?? [];
}

async function appendLogs(events: TrackedVoiceEvent[]) {
    if (!events.length) return;

    await DataStore.update<TrackedVoiceEvent[]>(LOG_KEY, oldLog => {
        const log = oldLog ?? [];
        // Preserve the event order from the dispatcher while keeping the newest event first.
        log.unshift(...[...events].reverse());

        const { maxEvents } = settings.store;
        if (maxEvents > 0 && log.length > maxEvents) log.length = maxEvents;

        return log;
    });

    emitLogUpdate();
}

async function clearLogs() {
    await DataStore.set(LOG_KEY, []);
    emitLogUpdate();
    showToast("VC Tracker history cleared", Toasts.Type.SUCCESS);
}

async function copyLogs() {
    const logs = await getLogs();
    await copyWithToast(JSON.stringify(logs, null, 4), "VC Tracker JSON copied!");
}

function openClearLogsConfirm() {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Clear VC Tracker history?"
            confirmText="Clear"
            cancelText="Cancel"
            onConfirm={clearLogs}
        >
            <Forms.FormText>
                This removes the saved local VC Tracker events. Active sessions will keep tracking from now.
            </Forms.FormText>
        </ConfirmModal>
    ));
}

function formatDuration(ms?: number) {
    if (ms == null) return "";

    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function formatStatus(voice: VoiceStatusSnapshot) {
    const parts = [
        voice.muted && "muted",
        voice.deafened && "deafened",
        voice.selfVideo && "camera",
        voice.selfStream && "streaming",
        voice.suppress && "suppressed",
    ].filter(Boolean);

    return parts.length ? parts.join(", ") : "normal";
}

/** Guild name when there is one, otherwise a DM/Group DM label instead of a misleading "unknown server". */
function getChannelContextLabel(guild: EntitySnapshot | null, channel: EntitySnapshot | null) {
    if (guild) return guild.name ?? guild.id;
    if (channel?.type === ChannelType.GROUP_DM) return "Group DM";
    if (channel?.type === ChannelType.DM) return "Direct Message";
    return "Unknown server";
}

function formatSessionDuration(session?: SessionSnapshot) {
    if (session?.durationMs == null) return "";

    const duration = formatDuration(session.durationMs);
    return session.approximate ? `~${duration} (exact time unknown, Vencord was closed)` : duration;
}

function formatChatEvent(event: TrackedVoiceEvent) {
    const user = event.trackedUser.name ?? event.trackedUser.id;
    const guild = getChannelContextLabel(event.guild, event.channel ?? event.oldChannel);
    const channel = event.channel?.name ?? event.channel?.id;
    const oldChannel = event.oldChannel?.name ?? event.oldChannel?.id;
    const members = (event.channelMemberCount ?? event.channelMembers.length)
        || (event.oldChannelMemberCount ?? event.oldChannelMembers.length);
    const membersTruncated = event.channelMembersTruncated || event.oldChannelMembersTruncated;
    const memberSummary = `${members}${membersTruncated ? " (preview)" : ""}`;
    const duration = formatSessionDuration(event.session);

    switch (event.type) {
        case "snapshot":
            return `[VC Tracker] ${user} is already in ${channel} (${guild}). Status: ${formatStatus(event.voice)}. Members: ${memberSummary}.`;
        case "join":
            return `[VC Tracker] ${user} joined ${channel} (${guild}). Status: ${formatStatus(event.voice)}. Members: ${memberSummary}.`;
        case "leave":
            return `[VC Tracker] ${user} left ${oldChannel} (${guild})${duration ? ` after ${duration}` : ""}. Last status: ${formatStatus(event.voice)}. Members left: ${memberSummary}.`;
        case "move":
            return `[VC Tracker] ${user} moved from ${oldChannel} to ${channel} (${guild})${duration ? ` after ${duration}` : ""}. Status: ${formatStatus(event.voice)}. Members: ${memberSummary}.`;
        case "state-update":
            return `[VC Tracker] ${user} updated voice status in ${channel} (${guild}): ${event.changes.map(change => `${change.key}: ${String(change.from)} -> ${String(change.to)}`).join(", ")}.`;
    }
}

function maybeSendChatSummary(event: TrackedVoiceEvent) {
    if (!settings.store.showChatSummary) return;

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    const author = UserStore.getUser(event.trackedUser.id);
    sendBotMessage(channelId, author
        ? { content: formatChatEvent(event), author }
        : { content: formatChatEvent(event) });
}

async function handleVoiceStateUpdates(rawVoiceStates: unknown) {
    const trackedUserIds = new Set(getTrackedUserIds());
    if (!trackedUserIds.size) return;

    const voiceStates = normalizeVoiceStates(rawVoiceStates);
    if (!voiceStates.length) return;

    await loadActiveSessions();

    let sessionsChanged = false;
    const events: TrackedVoiceEvent[] = [];

    for (const state of voiceStates) {
        if (!trackedUserIds.has(state.userId)) continue;

        // A live event is authoritative for this user, so a later store reconciliation must not
        // mistake a short-lived cache gap for a leave.
        delete missingVoiceStateSince[state.userId];

        try {
            const result = buildEvent(state);
            if (!result.event) continue;

            sessionsChanged ||= result.sessionsChanged;
            events.push(result.event);
        } catch (error) {
            // A malformed channel/member/profile must not discard the other tracked users in the
            // same large-guild batch.
            logger.error(`Failed to build voice event for ${state.userId}`, error);
        }
    }

    try {
        await appendLogs(events);
    } catch (error) {
        logger.error("Failed to persist voice state update batch", error);
    }

    for (const event of events) {
        try {
            maybeSendChatSummary(event);
        } catch (error) {
            logger.error("Failed to send voice event summary", error);
        }
    }

    if (sessionsChanged) await saveActiveSessions();
}

function enqueueVoiceStates(rawVoiceStates: unknown) {
    voiceQueue = voiceQueue
        .then(() => handleVoiceStateUpdates(rawVoiceStates))
        .catch(error => logger.error("Failed to process voice state update", error));
}

async function reconcileCurrentTrackedUsers(showDoneToast = false) {
    const trackedUserIds = getTrackedUserIds();
    if (!trackedUserIds.length) {
        if (showDoneToast) showToast("No tracked User IDs configured", Toasts.Type.FAILURE);
        return 0;
    }

    await loadActiveSessions();

    let count = 0;
    let sessionsChanged = false;
    const trackedUserIdSet = new Set(trackedUserIds);

    for (const [userId, session] of Object.entries(activeSessions)) {
        if (trackedUserIdSet.has(userId)) continue;
        delete activeSessions[userId];
        sessionsChanged = true;
        delete missingVoiceStateSince[userId];
    }

    const events: TrackedVoiceEvent[] = [];
    const now = Date.now();

    for (const userId of trackedUserIds) {
        let state: VoiceStateUpdate | null;
        try {
            state = normalizeVoiceState(VoiceStateStore?.getVoiceStateForUser?.(userId));
        } catch (error) {
            logger.error(`Failed to read the current voice state for ${userId}`, error);
            continue;
        }
        const activeSession = activeSessions[userId];
        let eventState: VoiceStateUpdate | undefined;

        if (state?.channelId) {
            delete missingVoiceStateSince[userId];
            eventState = state;
        } else if (activeSession) {
            // Large guilds can temporarily expose an incomplete VoiceStateStore. Keep the open
            // session through a grace period and only then reconstruct an approximate leave.
            const missingSince = missingVoiceStateSince[userId] ??= now;
            if (now - missingSince < VOICE_STATE_MISSING_GRACE_MS) continue;

            eventState = {
                ...statusToVoiceState(userId, activeSession.lastStatus, undefined, activeSession.guildId),
                oldChannelId: activeSession.channelId,
            };
            delete missingVoiceStateSince[userId];
        } else {
            delete missingVoiceStateSince[userId];
            continue;
        }

        try {
            const forceSnapshot = !activeSession && Boolean(eventState.channelId);
            const result = buildEvent(eventState, forceSnapshot ? "snapshot" : undefined, "reconciled");

            if (!result.event) continue;

            count++;
            sessionsChanged ||= result.sessionsChanged;
            events.push(result.event);
        } catch (error) {
            logger.error(`Failed to reconcile voice state for ${userId}`, error);
        }
    }

    try {
        await appendLogs(events);
    } catch (error) {
        logger.error("Failed to persist reconciled voice state batch", error);
    }

    for (const event of events) {
        try {
            maybeSendChatSummary(event);
        } catch (error) {
            logger.error("Failed to send reconciled voice event summary", error);
        }
    }

    if (sessionsChanged) await saveActiveSessions();
    if (showDoneToast) showToast(`Captured ${count} current voice state${count === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
    return count;
}

function enqueueCurrentStateReconciliation(showDoneToast = false) {
    voiceQueue = voiceQueue
        .then(async () => {
            await reconcileCurrentTrackedUsers(showDoneToast);
        })
        .catch(error => logger.error("Failed to reconcile tracked voice states", error));
}

function scheduleVoiceReconciliation(delayMs = VOICE_RECONCILE_DEBOUNCE_MS) {
    if (!trackerReady || voiceReconcileTimer != null) return;

    voiceReconcileTimer = setTimeout(() => {
        voiceReconcileTimer = undefined;
        enqueueCurrentStateReconciliation();
    }, Math.max(0, delayMs));
}

function startVoiceReconciliation() {
    trackerReady = true;

    if (!voiceStoreListener && VoiceStateStore?.addChangeListener) {
        voiceStoreListener = () => scheduleVoiceReconciliation();
        VoiceStateStore.addChangeListener(voiceStoreListener);
    }

    if (voiceReconcileInterval == null) {
        voiceReconcileInterval = setInterval(() => scheduleVoiceReconciliation(0), VOICE_RECONCILE_INTERVAL_MS);
    }

    // Run immediately, then retry after the store has had time to hydrate a large guild.
    scheduleVoiceReconciliation(0);
    voiceBootstrapTimers = [RECONCILE_RETRY_DELAY_MS, 10_000]
        .map(delay => setTimeout(() => scheduleVoiceReconciliation(0), delay));
}

function stopVoiceReconciliation() {
    trackerReady = false;

    if (voiceReconcileTimer != null) {
        clearTimeout(voiceReconcileTimer);
        voiceReconcileTimer = undefined;
    }
    if (voiceReconcileInterval != null) {
        clearInterval(voiceReconcileInterval);
        voiceReconcileInterval = undefined;
    }
    for (const timer of voiceBootstrapTimers) clearTimeout(timer);
    voiceBootstrapTimers = [];
    if (voiceStoreListener) {
        VoiceStateStore?.removeChangeListener?.(voiceStoreListener);
        voiceStoreListener = undefined;
    }

    for (const userId of Object.keys(missingVoiceStateSince)) delete missingVoiceStateSince[userId];
}

function useTrackerLogs() {
    const [signal, update] = useReducer((value: number) => value + 1, 0);

    useEffect(() => {
        logSignals.add(update);
        return () => {
            logSignals.delete(update);
        };
    }, []);

    const [logs, , pending] = useAwaiter(getLogs, {
        fallbackValue: [],
        deps: [signal],
    });

    return [logs, pending] as const;
}

function EntityIcon({ entity, size = 32, onClick }: { entity?: EntitySnapshot | UserSnapshot | null; size?: number; onClick?: () => void; }) {
    const label = entity?.name ?? entity?.id ?? "?";
    const clickableProps = onClick ? {
        role: "button" as const,
        tabIndex: 0,
        onClick,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") onClick(); },
        style: { cursor: "pointer" },
    } : {};

    if (entity?.iconUrl) {
        return (
            <img
                src={entity.iconUrl}
                alt=""
                {...clickableProps}
                style={{
                    width: size,
                    height: size,
                    borderRadius: "50%",
                    objectFit: "cover",
                    flex: "0 0 auto",
                    ...clickableProps.style,
                }}
            />
        );
    }

    return (
        <div
            {...clickableProps}
            style={{
                width: size,
                height: size,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                flex: "0 0 auto",
                background: "var(--background-modifier-accent)",
                color: "var(--text-muted)",
                fontSize: Math.max(11, Math.floor(size / 2.4)),
                fontWeight: 700,
                ...clickableProps.style,
            }}
        >
            {label[0]?.toUpperCase() ?? "?"}
        </div>
    );
}

function EventPill({ label, color }: { label: string; color: string; }) {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 20,
                padding: "0 8px",
                borderRadius: 4,
                background: color,
                color: "white",
                fontSize: 12,
                fontWeight: 700,
            }}
        >
            {label}
        </span>
    );
}

const statusIconDefs: Array<{
    key: "muted" | "deafened" | "selfVideo" | "selfStream";
    label: string;
    Icon: (props: { width: number; height: number; }) => JSX.Element;
    color: string;
}> = [
    { key: "deafened", label: "Deafened", Icon: Deafened, color: "var(--status-danger)" },
    { key: "muted", label: "Muted", Icon: MicrophoneMuted, color: "var(--status-danger)" },
    { key: "selfVideo", label: "Camera on", Icon: Camera, color: "var(--status-positive)" },
    { key: "selfStream", label: "Streaming", Icon: ScreenshareIcon, color: "var(--status-positive)" },
];

/** Only renders icons for states that are actually active, instead of a wall of always-visible pills. */
function StatusIconRow({ voice }: { voice: VoiceStatusSnapshot; }) {
    const active = statusIconDefs.filter(({ key }) => voice[key]);
    if (!active.length) return null;

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {active.map(({ key, label, Icon, color }) => (
                <div key={key} title={label} style={{ color, display: "flex" }}>
                    <Icon width={16} height={16} />
                </div>
            ))}
        </div>
    );
}

function MembersPreview({ members, totalCount = members.length }: { members: ChannelMemberSnapshot[]; totalCount?: number; }) {
    if (!members.length) return null;

    const visibleMembers = members.slice(0, 12);
    const extra = Math.max(0, totalCount - visibleMembers.length);

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <Forms.FormText style={{ flex: "0 0 auto" }}>Call:</Forms.FormText>
            <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {visibleMembers.map(member => (
                    <div
                        key={member.user.id}
                        title={`${member.user.name ?? member.user.id} (${formatStatus(member.voice)})`}
                        style={{ marginLeft: -4 }}
                    >
                        <EntityIcon entity={member.user} size={24} onClick={() => openUserProfile(member.user.id)} />
                    </div>
                ))}
                {!!extra && (
                    <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: 12 }}>
                        +{extra}
                    </span>
                )}
            </div>
        </div>
    );
}

function EventRow({ event }: { event: TrackedVoiceEvent; }) {
    const meta = eventMeta[event.type];
    const members = event.channelMembers.length ? event.channelMembers : event.oldChannelMembers;
    const memberCount = event.channelMembers.length
        ? event.channelMemberCount ?? event.channelMembers.length
        : event.oldChannelMemberCount ?? event.oldChannelMembers.length;

    return (
        <div
            style={{
                display: "grid",
                gridTemplateColumns: "48px minmax(0, 1fr)",
                gap: 12,
                padding: "12px 0",
                borderBottom: "1px solid var(--background-modifier-accent)",
            }}
        >
            <EntityIcon entity={event.trackedUser} size={48} onClick={() => openUserProfile(event.trackedUser.id)} />
            <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <EventPill label={meta.label} color={meta.color} />
                    <Forms.FormTitle tag="h4" style={{ margin: 0 }}>
                        {event.trackedUser.name ?? event.trackedUser.id}
                    </Forms.FormTitle>
                    <Timestamp timestamp={new Date(event.timestamp)} />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, minWidth: 0 }}>
                    <EntityIcon entity={event.guild} size={24} />
                    <Forms.FormText style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {getChannelContextLabel(event.guild, event.channel ?? event.oldChannel)}
                        {" / "}
                        {event.oldChannel && event.channel && event.oldChannel.id !== event.channel.id
                            ? `${event.oldChannel.name ?? event.oldChannel.id} -> ${event.channel.name ?? event.channel.id}`
                            : event.channel?.name ?? event.oldChannel?.name ?? event.channel?.id ?? event.oldChannel?.id ?? "No channel"}
                    </Forms.FormText>
                    <StatusIconRow voice={event.voice} />
                </div>

                {!!event.session?.durationMs && (
                    <Forms.FormText style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                        Duration: {formatSessionDuration(event.session)}
                    </Forms.FormText>
                )}

                {event.source === "reconciled" && (
                    <Forms.FormText style={{ marginTop: 4, color: "var(--status-warning)", fontSize: 12 }}>
                        Detected after Vencord (re)started - exact timing may not be precise.
                    </Forms.FormText>
                )}

                {!!event.changes.length && (
                    <Forms.FormText style={{ marginTop: 8 }}>
                        {event.changes.map(change => `${change.key}: ${String(change.from)} -> ${String(change.to)}`).join(", ")}
                    </Forms.FormText>
                )}

                <div style={{ marginTop: 8 }}>
                    <MembersPreview members={members} totalCount={memberCount} />
                </div>
            </div>
        </div>
    );
}

function TrackerLogModal(props: RenderModalProps) {
    const [logs, pending] = useTrackerLogs();

    return (
        <Modal
            {...props}
            size="xl"
            title="VC Tracker Log"
            actions={[
                {
                    text: "Copy JSON",
                    variant: "secondary",
                    disabled: !logs.length,
                    onClick: copyLogs,
                },
                {
                    text: "Clear History",
                    variant: "critical-primary",
                    disabled: !logs.length,
                    onClick: openClearLogsConfirm,
                },
            ]}
        >
            {!logs.length && !pending ? (
                <Forms.FormText style={{ textAlign: "center", padding: 32 }}>
                    No tracked voice events yet.
                </Forms.FormText>
            ) : (
                <ScrollerThin style={{ maxHeight: 620, paddingRight: 8 }}>
                    {logs.map(event => <EventRow key={event.id} event={event} />)}
                </ScrollerThin>
            )}
        </Modal>
    );
}

function openTrackerLogModal() {
    openModal(props => <TrackerLogModal {...props} />);
}

function SettingsAboutComponent() {
    const [logs, pending] = useTrackerLogs();

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <Forms.FormTitle tag="h3">VC Tracker History</Forms.FormTitle>
            <Forms.FormText>
                {pending ? "Loading saved events..." : `${logs.length} saved event${logs.length === 1 ? "" : "s"}.`}
            </Forms.FormText>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={openTrackerLogModal}>Open Visual Log</Button>
                <Button onClick={copyLogs} disabled={!logs.length}>Copy JSON</Button>
                <Button onClick={() => enqueueCurrentStateReconciliation(true)}>Capture Current State</Button>
                <Button onClick={openClearLogsConfirm} disabled={!logs.length}>Clear History</Button>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "vcTracker",
    description: "Tracks configured users across voice calls and stores a rich local voice activity history.",
    tags: ["Voice", "Activity", "Notifications"],
    authors: [Devs.trapstar],
    reporterTestable: ReporterTestable.None,

    settings,

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates?: unknown; }) {
            enqueueVoiceStates(voiceStates);
            scheduleVoiceReconciliation();
        },
        CONNECTION_OPEN() {
            scheduleVoiceReconciliation(RECONCILE_RETRY_DELAY_MS);
        },
        CONNECTION_RESUMED() {
            scheduleVoiceReconciliation(RECONCILE_RETRY_DELAY_MS);
        },
        GUILD_CREATE() {
            scheduleVoiceReconciliation(RECONCILE_RETRY_DELAY_MS);
        },
    },

    start() {
        const lifecycle = ++trackerLifecycle;
        voiceQueue = voiceQueue
            .then(async () => {
                try {
                    await reconcileCurrentTrackedUsers(false);
                } finally {
                    if (lifecycle === trackerLifecycle) startVoiceReconciliation();
                }
            })
            .catch(error => logger.error("Failed to initialize voice tracker", error));
    },

    stop() {
        trackerLifecycle++;
        stopVoiceReconciliation();
    },

    settingsAboutComponent: SettingsAboutComponent,
});
