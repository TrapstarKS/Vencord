/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { getUniqueUsername } from "@utils/discord";
import type { RenderModalProps, User } from "@vencord/discord-types";
import { Button, ChannelStore, Forms, GuildStore, Modal, NavigationRouter, openModal, Parser, ScrollerThin, Select, TabBar, TextInput, Tooltip, useEffect, useMemo, useReducer, UserStore, UserUtils, useState } from "@webpack/common";
import type { JSX, ReactNode } from "react";

import { getAggregate, getAllSummaries, getMessages, getVersion, getVoiceCalls, subscribe } from "./tracking";
import { ActivityBucket, PresenceState, TrackedMessage, TrackedVoiceCall, UserAggregate, UserSummary } from "./types";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_COLORS: Record<PresenceState, string> = {
    online: "#23a55a",
    idle: "#f0b232",
    dnd: "#f23f43",
    offline: "#80848e"
};

/** Re-renders the caller whenever tracked data mutates, so an open modal reflects live activity. */
function useTrackingVersion() {
    const [version, setVersion] = useState(getVersion);
    useEffect(() => subscribe(() => setVersion(getVersion())), []);
    return version;
}

function formatHours(ms: number) {
    return (ms / 3600000).toFixed(1);
}

function onlineMs(totals: ActivityBucket) {
    return totals.onlineMs + totals.idleMs + totals.dndMs;
}

function bucketActivityMs(bucket: ActivityBucket | undefined) {
    if (!bucket) return 0;
    return bucket.onlineMs + bucket.idleMs + bucket.dndMs + bucket.voiceMs;
}

function totalActivityMs(summary: UserSummary) {
    return onlineMs(summary.totals) + summary.totals.voiceMs;
}

function getDisplayName(userId: string) {
    const user = UserStore.getUser(userId);
    return user ? getUniqueUsername(user) : "Unknown user";
}

function heatColor(intensity: number) {
    return intensity <= 0
        ? "var(--background-secondary)"
        : `hsl(235, 70%, ${Math.max(22, 58 - intensity * 36)}%)`;
}

const DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
/** Rendering thousands of parsed messages at once is expensive; cap the visible slice and hint at the rest. */
const MESSAGE_RENDER_CAP = 100;
const VOICE_RENDER_CAP = 200;

function formatDateTime(ts: number) {
    return DATE_TIME_FMT.format(ts);
}

function formatDuration(ms: number) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

/** Human label for a stored channel: "Direct Messages", a group-DM name, or "#channel · Guild". */
function channelLabel(channelId: string, guildId?: string): string {
    const channel = ChannelStore.getChannel(channelId) as any;
    if (!channel) return guildId ? "Unknown channel" : "Direct Messages";
    if (channel.isDM?.()) return "Direct Messages";
    if (channel.isGroupDM?.()) return channel.name || "Group DM";
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
    const name = channel.name ? `#${channel.name}` : "#unknown";
    return guild ? `${name} · ${guild.name}` : name;
}

function jumpToMessage(message: TrackedMessage, close: () => void) {
    close();
    NavigationRouter.transitionTo(`/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`);
}

function jumpToChannel(call: TrackedVoiceCall, close: () => void) {
    close();
    NavigationRouter.transitionTo(`/channels/${call.guildId ?? "@me"}/${call.channelId}`);
}

function renderMessageContent(message: TrackedMessage): ReactNode {
    if (message.content) {
        return Parser.parse(message.content, true, {
            channelId: message.channelId,
            messageId: message.id,
            allowLinks: true
        });
    }
    if (message.attachmentCount) {
        return <span className="vc-aa-msg-placeholder">[{message.attachmentCount} attachment{message.attachmentCount === 1 ? "" : "s"}]</span>;
    }
    return <span className="vc-aa-msg-placeholder">[no text content]</span>;
}

function Avatar({ userId, size, status }: { userId: string; size: number; status?: PresenceState; }) {
    const user = UserStore.getUser(userId) as User | undefined;
    const url = user?.getAvatarURL?.(undefined, size, false);
    const name = getDisplayName(userId);

    return (
        <div className="vc-aa-avatar-wrap" style={{ width: size, height: size }}>
            {url ? (
                <img className="vc-aa-avatar" src={url} alt="" />
            ) : (
                <div className="vc-aa-avatar vc-aa-avatar-fallback" style={{ fontSize: Math.max(11, Math.floor(size / 2.4)) }}>
                    {name[0]?.toUpperCase() ?? "?"}
                </div>
            )}
            {status && <div className="vc-aa-status-dot" style={{ background: STATUS_COLORS[status] }} />}
        </div>
    );
}

function SummaryRow({ summary, onSelect }: { summary: UserSummary; onSelect: (id: string) => void; }) {
    return (
        <div
            className="vc-aa-row"
            role="button"
            tabIndex={0}
            onClick={() => onSelect(summary.userId)}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(summary.userId);
                }
            }}
        >
            <Avatar userId={summary.userId} size={32} status={summary.lastPresence} />
            <div className="vc-aa-name">
                {getDisplayName(summary.userId)}
                {!summary.isFriend && <span className="vc-aa-pill">implicit</span>}
            </div>
            <Forms.FormText className="vc-aa-stat">{formatHours(onlineMs(summary.totals))}h online</Forms.FormText>
            <Forms.FormText className="vc-aa-stat">{formatHours(summary.totals.voiceMs)}h voice</Forms.FormText>
            <Forms.FormText className="vc-aa-stat">{summary.totals.messageCount} msgs</Forms.FormText>
        </div>
    );
}

function Heatmap({ aggregate }: { aggregate: UserAggregate | undefined; }) {
    const max = useMemo(() => {
        if (!aggregate) return 0;
        return Math.max(1, ...Object.values(aggregate.buckets).map(bucketActivityMs));
    }, [aggregate]);

    const cells: JSX.Element[] = [<div key="corner" />];

    for (let hour = 0; hour < 24; hour++) {
        cells.push(
            <div key={`h-${hour}`} className="vc-aa-axis-label vc-aa-axis-hour">
                {hour % 3 === 0 ? hour : ""}
            </div>
        );
    }

    for (let day = 0; day < 7; day++) {
        cells.push(
            <div key={`d-${day}`} className="vc-aa-axis-label">{DAY_LABELS[day]}</div>
        );

        for (let hour = 0; hour < 24; hour++) {
            const value = bucketActivityMs(aggregate?.buckets[`${day}-${hour}`]);
            const intensity = max ? value / max : 0;

            cells.push(
                <Tooltip key={`${day}-${hour}`} text={`${DAY_LABELS[day]} ${hour}:00 — ${formatHours(value)}h`}>
                    {tooltipProps => (
                        <div
                            {...tooltipProps}
                            className="vc-aa-heatmap-cell"
                            style={{ background: heatColor(intensity) }}
                        />
                    )}
                </Tooltip>
            );
        }
    }

    return (
        <div>
            <div className="vc-aa-heatmap">{cells}</div>
            <div className="vc-aa-legend">
                <span>Less</span>
                {[0, 0.25, 0.5, 0.75, 1].map(intensity => (
                    <div key={intensity} className="vc-aa-legend-cell" style={{ background: heatColor(intensity) }} />
                ))}
                <span>More</span>
            </div>
        </div>
    );
}

function OverlapList({ summaries, primaryId }: { summaries: UserSummary[]; primaryId: string; }) {
    const version = useTrackingVersion();
    const [compareId, setCompareId] = useState<string | undefined>(undefined);

    const options = useMemo(
        () => summaries.filter(s => s.userId !== primaryId).map(s => ({ value: s.userId, label: getDisplayName(s.userId) })),
        [summaries, primaryId]
    );

    const overlaps = useMemo(() => {
        const primaryAgg = getAggregate(primaryId);
        const compareAgg = compareId ? getAggregate(compareId) : undefined;
        if (!primaryAgg || !compareAgg) return [];

        const scores: Array<{ key: string; score: number; }> = [];
        for (let day = 0; day < 7; day++) {
            for (let hour = 0; hour < 24; hour++) {
                const key = `${day}-${hour}`;
                const score = Math.min(bucketActivityMs(primaryAgg.buckets[key]), bucketActivityMs(compareAgg.buckets[key]));
                if (score > 0) scores.push({ key, score });
            }
        }

        return scores.sort((a, b) => b.score - a.score).slice(0, 5);
    }, [primaryId, compareId, version]);

    return (
        <div style={{ marginTop: 16 }}>
            <Forms.FormTitle tag="h5">Overlapping active hours</Forms.FormTitle>
            <Select
                placeholder="Compare with..."
                options={options}
                isSelected={value => value === compareId}
                select={value => setCompareId(value)}
                serialize={value => String(value)}
            />
            <div style={{ marginTop: 8 }}>
                {compareId && (
                    overlaps.length
                        ? overlaps.map(({ key, score }) => {
                            const [day, hour] = key.split("-").map(Number);
                            return (
                                <Forms.FormText key={key}>
                                    {DAY_LABELS[day]} {hour}:00 — {formatHours(score)}h overlap
                                </Forms.FormText>
                            );
                        })
                        : <Forms.FormText>No overlapping activity yet.</Forms.FormText>
                )}
            </div>
        </div>
    );
}

function MessageRow({ message, close }: { message: TrackedMessage; close: () => void; }) {
    return (
        <div className="vc-aa-msg-row">
            <div className="vc-aa-msg-meta">
                <span className="vc-aa-msg-channel">{channelLabel(message.channelId, message.guildId)}</span>
                <span className="vc-aa-msg-time">{formatDateTime(message.timestamp)}</span>
            </div>
            <div className="vc-aa-msg-content">{renderMessageContent(message)}</div>
            <Button
                size={Button.Sizes.SMALL}
                look={Button.Looks.LINK}
                className="vc-aa-jump"
                onClick={() => jumpToMessage(message, close)}
            >
                Jump
            </Button>
        </div>
    );
}

function MessagesTab({ userId, version, close }: { userId: string; version: number; close: () => void; }) {
    const [query, setQuery] = useState("");
    // Read fresh each render: getMessages returns a live, in-place-mutated array, so the version bump
    // (not a new reference) is what tells us to recompute — hence version in the memo deps below.
    const messages = getMessages(userId);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return messages;
        return messages.filter(m =>
            m.content.toLowerCase().includes(q) || channelLabel(m.channelId, m.guildId).toLowerCase().includes(q));
    }, [userId, query, version]);

    if (!messages.length) {
        return (
            <Forms.FormText className="vc-aa-empty">
                No messages logged yet. Messages are recorded as this contact sends them while tracking is active.
            </Forms.FormText>
        );
    }

    const shown = filtered.slice(0, MESSAGE_RENDER_CAP);

    return (
        <div className="vc-aa-tab-panel">
            <TextInput
                className="vc-aa-search"
                value={query}
                onChange={setQuery}
                placeholder="Search messages…"
            />
            <Forms.FormText className="vc-aa-result-count">
                {filtered.length} message{filtered.length === 1 ? "" : "s"}
                {filtered.length > shown.length ? ` · showing first ${shown.length}` : ""}
            </Forms.FormText>
            <ScrollerThin className="vc-aa-log-scroller">
                {shown.length
                    ? shown.map(m => <MessageRow key={m.id} message={m} close={close} />)
                    : <Forms.FormText className="vc-aa-empty">No messages match your search.</Forms.FormText>}
            </ScrollerThin>
        </div>
    );
}

function VoiceRow({ call, close }: { call: TrackedVoiceCall; close: () => void; }) {
    return (
        <div className="vc-aa-voice-row">
            <div className="vc-aa-voice-main">
                <div className="vc-aa-voice-channel">{channelLabel(call.channelId, call.guildId)}</div>
                <div className="vc-aa-voice-sub">
                    {formatDateTime(call.startedAt)}{call.approximate ? " · approx." : ""}
                </div>
            </div>
            <div className="vc-aa-voice-duration">{formatDuration(call.durationMs)}</div>
            <Button
                size={Button.Sizes.SMALL}
                look={Button.Looks.LINK}
                className="vc-aa-jump"
                onClick={() => jumpToChannel(call, close)}
            >
                Open
            </Button>
        </div>
    );
}

function VoiceTab({ userId, version, close }: { userId: string; version: number; close: () => void; }) {
    const calls = useMemo(() => getVoiceCalls(userId), [userId, version]);

    if (!calls.length) {
        return <Forms.FormText className="vc-aa-empty">No voice calls logged yet.</Forms.FormText>;
    }

    return (
        <div className="vc-aa-tab-panel">
            <ScrollerThin className="vc-aa-log-scroller">
                {calls.slice(0, VOICE_RENDER_CAP).map((call, i) => (
                    <VoiceRow key={`${call.channelId}-${call.startedAt}-${i}`} call={call} close={close} />
                ))}
            </ScrollerThin>
        </div>
    );
}

type DetailTab = "overview" | "messages" | "voice";

function UserDetail({ userId, summary, summaries, version, onBack, close }: {
    userId: string;
    summary: UserSummary | undefined;
    summaries: UserSummary[];
    version: number;
    onBack: () => void;
    close: () => void;
}) {
    const [tab, setTab] = useState<DetailTab>("overview");

    const messageCount = useMemo(() => getMessages(userId).length, [userId, version]);
    const callCount = useMemo(() => getVoiceCalls(userId).length, [userId, version]);

    return (
        <div>
            <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} onClick={onBack}>
                ← Back to overview
            </Button>
            <div className="vc-aa-detail-header">
                <Avatar userId={userId} size={64} status={summary?.lastPresence} />
                <div>
                    <Forms.FormTitle tag="h3" style={{ margin: 0 }}>{getDisplayName(userId)}</Forms.FormTitle>
                    {summary ? (
                        <Forms.FormText>
                            {formatHours(onlineMs(summary.totals))}h online · {formatHours(summary.totals.voiceMs)}h voice · {summary.totals.messageCount} messages
                        </Forms.FormText>
                    ) : (
                        <Forms.FormText>No activity tracked for this user yet.</Forms.FormText>
                    )}
                </div>
            </div>

            <TabBar
                type="top"
                look="brand"
                className="vc-aa-tab-bar"
                selectedItem={tab}
                onItemSelect={setTab}
            >
                <TabBar.Item className="vc-aa-tab-item" id="overview">Overview</TabBar.Item>
                <TabBar.Item className="vc-aa-tab-item" id="messages">
                    Messages{messageCount ? ` (${messageCount})` : ""}
                </TabBar.Item>
                <TabBar.Item className="vc-aa-tab-item" id="voice">
                    Voice{callCount ? ` (${callCount})` : ""}
                </TabBar.Item>
            </TabBar>

            <div className="vc-aa-tab-content">
                {tab === "overview" && (
                    <>
                        <Heatmap key={version} aggregate={getAggregate(userId)} />
                        <OverlapList summaries={summaries} primaryId={userId} />
                    </>
                )}
                {tab === "messages" && <MessagesTab userId={userId} version={version} close={close} />}
                {tab === "voice" && <VoiceTab userId={userId} version={version} close={close} />}
            </div>
        </div>
    );
}

function ActivityAnalyticsModalInner(props: RenderModalProps & { initialUserId?: string; }) {
    const version = useTrackingVersion();
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    const summaries = useMemo(
        () => getAllSummaries().sort((a, b) => totalActivityMs(b) - totalActivityMs(a)),
        [version]
    );

    const [selectedId, setSelectedId] = useState<string | undefined>(props.initialUserId);
    const selectedSummary = selectedId ? summaries.find(s => s.userId === selectedId) : undefined;

    // Implicit contacts (and stale-cache friends) are frequently absent from the UserStore; fetch the
    // missing ones so names/avatars render instead of raw snowflakes, then re-render when they resolve.
    useEffect(() => {
        const ids = new Set(summaries.map(s => s.userId));
        if (selectedId) ids.add(selectedId);
        const missing = [...ids].filter(id => !UserStore.getUser(id));
        if (!missing.length) return;
        Promise.allSettled(missing.map(id => UserUtils.getUser(id))).then(forceUpdate);
    }, [summaries, selectedId]);

    return (
        <Modal {...props} size="xl" title="Activity Analytics">
            {!summaries.length && !selectedId ? (
                <Forms.FormText style={{ textAlign: "center", padding: 32 }}>
                    No activity tracked yet.
                </Forms.FormText>
            ) : selectedId ? (
                <UserDetail
                    userId={selectedId}
                    summary={selectedSummary}
                    summaries={summaries}
                    version={version}
                    onBack={() => setSelectedId(undefined)}
                    close={props.onClose}
                />
            ) : (
                <ScrollerThin style={{ maxHeight: 620, paddingRight: 8 }}>
                    {summaries.map(summary => (
                        <SummaryRow key={summary.userId} summary={summary} onSelect={setSelectedId} />
                    ))}
                </ScrollerThin>
            )}
        </Modal>
    );
}

const ActivityAnalyticsModal = ErrorBoundary.wrap(ActivityAnalyticsModalInner);

export function openActivityAnalyticsModal(initialUserId?: string) {
    openModal(props => <ActivityAnalyticsModal {...props} initialUserId={initialUserId} />);
}

export function SettingsAboutComponent() {
    const version = useTrackingVersion();
    const summaries = useMemo(() => getAllSummaries(), [version]);

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <Forms.FormTitle tag="h3">Activity Analytics</Forms.FormTitle>
            <Forms.FormText>
                {summaries.length} tracked user{summaries.length === 1 ? "" : "s"}.
            </Forms.FormText>
            <div>
                <Button onClick={() => openActivityAnalyticsModal()}>Open Activity Analytics</Button>
            </div>
        </div>
    );
}
