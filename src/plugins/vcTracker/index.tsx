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
    oldChannelMembers: ChannelMemberSnapshot[];
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

function getTrackedUserIds() {
    return parseUserIds(settings.store.trackedUserIds);
}

function getUserSnapshot(userId: string, guildId?: string | null): UserSnapshot {
    const user = UserStore.getUser(userId) as User | undefined;
    const member = guildId ? GuildMemberStore.getMember(guildId, userId) : undefined;
    const guildAvatarUrl = guildId && member?.avatar
        ? IconUtils.getGuildMemberAvatarURLSimple({
            guildId,
            userId,
            avatar: member.avatar,
            canAnimate: true,
            size: 128,
        })
        : undefined;
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : undefined;

    return {
        id: userId,
        name: nick ?? user?.globalName ?? user?.username ?? userId,
        username: user?.username,
        globalName: user?.globalName,
        tag: user?.tag,
        avatarUrl: user?.getAvatarURL?.(undefined, 128, true),
        guildAvatarUrl,
        iconUrl: guildAvatarUrl ?? user?.getAvatarURL?.(undefined, 128, true),
        bot: user?.bot,
    };
}

function getGuildSnapshot(guildId?: string | null): EntitySnapshot | null {
    if (!guildId) return null;

    const guild = GuildStore.getGuild(guildId);
    return {
        id: guildId,
        name: guild?.name,
        iconUrl: guild ? IconUtils.getGuildIconURL({
            id: guild.id,
            icon: guild.icon,
            canAnimate: true,
            size: 64,
        }) : undefined,
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

    const channel = ChannelStore.getChannel(channelId) as Channel | undefined;
    return {
        id: channelId,
        name: getChannelDisplayName(channel) ?? channelId,
        iconUrl: channel ? IconUtils.getChannelIconURL({
            id: channel.id,
            icon: channel.icon,
            applicationId: channel.application_id,
            size: 64,
        }) : undefined,
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

function getChannelMembers(channelId?: string | null): ChannelMemberSnapshot[] {
    if (!settings.store.includeCallMembers || !channelId) return [];

    const channel = ChannelStore.getChannel(channelId) as Channel | undefined;
    const guildId = channel?.guild_id;
    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceStateUpdate> | undefined;

    return Object.values(voiceStates ?? {})
        .map(voiceState => ({
            user: getUserSnapshot(voiceState.userId, guildId),
            voice: getVoiceStatus(voiceState),
        }))
        .sort((a, b) => (a.user.name ?? a.user.id).localeCompare(b.user.name ?? b.user.id));
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

    const channel = ChannelStore.getChannel(currentChannelId!) as Channel | undefined;
    const oldChannel = ChannelStore.getChannel(oldChannelId!) as Channel | undefined;
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
        channelMembers: getChannelMembers(currentChannelId),
        oldChannelMembers: oldChannelId && oldChannelId !== currentChannelId ? getChannelMembers(oldChannelId) : [],
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

async function appendLog(event: TrackedVoiceEvent) {
    await DataStore.update<TrackedVoiceEvent[]>(LOG_KEY, oldLog => {
        const log = oldLog ?? [];
        log.unshift(event);

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
    const members = event.channelMembers.length || event.oldChannelMembers.length;
    const duration = formatSessionDuration(event.session);

    switch (event.type) {
        case "snapshot":
            return `[VC Tracker] ${user} is already in ${channel} (${guild}). Status: ${formatStatus(event.voice)}. Members: ${members}.`;
        case "join":
            return `[VC Tracker] ${user} joined ${channel} (${guild}). Status: ${formatStatus(event.voice)}. Members: ${members}.`;
        case "leave":
            return `[VC Tracker] ${user} left ${oldChannel} (${guild})${duration ? ` after ${duration}` : ""}. Last status: ${formatStatus(event.voice)}. Members left: ${members}.`;
        case "move":
            return `[VC Tracker] ${user} moved from ${oldChannel} to ${channel} (${guild})${duration ? ` after ${duration}` : ""}. Status: ${formatStatus(event.voice)}. Members: ${members}.`;
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

async function handleVoiceStateUpdates(voiceStates: VoiceStateUpdate[]) {
    const trackedUserIds = getTrackedUserIds();
    if (!trackedUserIds.length) return;

    await loadActiveSessions();

    let sessionsChanged = false;

    for (const state of voiceStates) {
        if (!trackedUserIds.includes(state.userId)) continue;

        const result = buildEvent(state);
        if (!result.event) continue;

        sessionsChanged ||= result.sessionsChanged;
        await appendLog(result.event);
        maybeSendChatSummary(result.event);
    }

    if (sessionsChanged) await saveActiveSessions();
}

function enqueueVoiceStates(voiceStates: VoiceStateUpdate[]) {
    voiceQueue = voiceQueue
        .then(() => handleVoiceStateUpdates(voiceStates))
        .catch(error => logger.error("Failed to process voice state update", error));
}

async function seedCurrentTrackedUsers(showDoneToast = true) {
    const trackedUserIds = getTrackedUserIds();
    if (!trackedUserIds.length) {
        if (showDoneToast) showToast("No tracked User IDs configured", Toasts.Type.FAILURE);
        return;
    }

    await loadActiveSessions();

    let count = 0;
    let sessionsChanged = false;
    const trackedUserIdSet = new Set(trackedUserIds);

    for (const [userId, session] of Object.entries(activeSessions)) {
        if (trackedUserIdSet.has(userId)) continue;
        delete activeSessions[userId];
        sessionsChanged = true;
    }

    const currentStates = new Map(
        trackedUserIds.map(userId => [userId, VoiceStateStore.getVoiceStateForUser(userId) as VoiceStateUpdate | undefined])
    );

    // A user who has a persisted session but no current voice state might just be caught
    // mid-hydration - recheck once after a delay before treating it as a real leave.
    const pendingRecheck = trackedUserIds.filter(userId => !currentStates.get(userId)?.channelId && activeSessions[userId]);

    if (pendingRecheck.length) {
        await new Promise(resolve => setTimeout(resolve, RECONCILE_RETRY_DELAY_MS));
        for (const userId of pendingRecheck) {
            currentStates.set(userId, VoiceStateStore.getVoiceStateForUser(userId) as VoiceStateUpdate | undefined);
        }
    }

    for (const userId of trackedUserIds) {
        const state = currentStates.get(userId);
        const activeSession = activeSessions[userId];
        const eventState = state?.channelId
            ? state
            : activeSession
                ? {
                    ...statusToVoiceState(userId, activeSession.lastStatus, undefined, activeSession.guildId),
                    oldChannelId: activeSession.channelId,
                }
                : undefined;

        if (!eventState) continue;

        const forceSnapshot = !activeSession && Boolean(eventState.channelId);
        const result = buildEvent(eventState, forceSnapshot ? "snapshot" : undefined, "reconciled");

        if (!result.event) continue;

        count++;
        sessionsChanged ||= result.sessionsChanged;
        await appendLog(result.event);
        maybeSendChatSummary(result.event);
    }

    if (sessionsChanged) await saveActiveSessions();
    if (showDoneToast) showToast(`Captured ${count} current voice state${count === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
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

function MembersPreview({ members }: { members: ChannelMemberSnapshot[]; }) {
    if (!members.length) return null;

    const visibleMembers = members.slice(0, 12);
    const extra = members.length - visibleMembers.length;

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
                    <MembersPreview members={members} />
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
                <Button onClick={() => void seedCurrentTrackedUsers()}>Capture Current State</Button>
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
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateUpdate[]; }) {
            enqueueVoiceStates(voiceStates);
        },
    },

    start() {
        void seedCurrentTrackedUsers(false);
    },

    settingsAboutComponent: SettingsAboutComponent,
});
