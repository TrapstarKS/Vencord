/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Flex } from "@components/Flex";
import { Button, ConfirmModal, Forms, openModal, React, SettingsRouter, Toasts, useEffect, useState } from "@webpack/common";

import {
    checkSessions,
    clearEventHistory,
    getSessionGuardState,
    loadSessionGuardState,
    logoutAllOtherSessions,
    logoutSessions,
    rebaselineFromServer,
    subscribeSessionGuard,
    trustAllCurrentSessions,
    trustSession
} from "./store";
import { KnownSession, SessionEvent, sessionLabel } from "./types";

function formatWhen(ts: number | null) {
    if (ts == null) return "Never";
    return new Date(ts).toLocaleString();
}

function formatClock(ts: number) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(ts);
}

function eventTitle(ev: SessionEvent) {
    switch (ev.type) {
        case "new": return "New session";
        case "gone": return "Session gone";
        case "baseline": return "Baseline";
        case "trusted": return "Trusted";
        case "logout": return "Logged out";
        case "check": return "Check";
        default: return ev.type;
    }
}

function SessionRow({ session, busy, onChanged }: {
    session: KnownSession;
    busy: boolean;
    onChanged(): void;
}) {
    return (
        <div className="vc-sessionGuard-row">
            <div className="vc-sessionGuard-rowInfo">
                <div className="vc-sessionGuard-rowName">{sessionLabel(session)}</div>
                <div className="vc-sessionGuard-rowMeta">
                    First seen {formatWhen(session.firstSeenAt)} · Last active {formatWhen(session.lastUsedAt)}
                </div>
            </div>
            <div className="vc-sessionGuard-badges">
                {session.trusted
                    ? <span className="vc-sessionGuard-badge vc-sessionGuard-badgeTrusted">Trusted</span>
                    : <span className="vc-sessionGuard-badge vc-sessionGuard-badgeNew">Untrusted</span>}
            </div>
            <div className="vc-sessionGuard-rowActions">
                {!session.trusted && (
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={busy}
                        onClick={() => {
                            void trustSession(session.idHash).then(onChanged);
                        }}
                    >
                        Trust
                    </Button>
                )}
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    disabled={busy}
                    onClick={() => {
                        openModal(props => (
                            <ConfirmModal
                                {...props}
                                title="Log out this session?"
                                confirmText="Log out session"
                                cancelText="Cancel"
                                variant="danger"
                                onConfirm={() => {
                                    void logoutSessions([session.idHash])
                                        .then(() => {
                                            Toasts.show({
                                                message: "Session logged out.",
                                                id: Toasts.genId(),
                                                type: Toasts.Type.SUCCESS
                                            });
                                            onChanged();
                                        })
                                        .catch(() => {
                                            Toasts.show({
                                                message: "Failed to log out session.",
                                                id: Toasts.genId(),
                                                type: Toasts.Type.FAILURE
                                            });
                                        });
                                }}
                            >
                                This invalidates the remote session for <strong>{sessionLabel(session)}</strong>.
                                If it is this client, you may be signed out.
                            </ConfirmModal>
                        ));
                    }}
                >
                    Log out
                </Button>
            </div>
        </div>
    );
}

export function SessionGuardDashboard() {
    const [version, setVersion] = useState(0);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        const unsub = subscribeSessionGuard(() => setVersion(v => v + 1));
        void loadSessionGuardState();
        return unsub;
    }, []);

    // version forces re-read of module state
    void version;
    const state = getSessionGuardState();
    const sessions = state
        ? Object.values(state.known).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        : [];
    const events = state?.events ?? [];

    async function run(op: () => Promise<string | void>) {
        setBusy(true);
        setMessage(null);
        try {
            const result = await op();
            if (typeof result === "string") setMessage(result);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : "Operation failed.");
        } finally {
            setBusy(false);
            setVersion(v => v + 1);
        }
    }

    return (
        <div className="vc-sessionGuard">
            <div className="vc-sessionGuard-header">
                <div className="vc-sessionGuard-status">
                    <Forms.FormTitle tag="h5">Session Guard</Forms.FormTitle>
                    <div className="vc-sessionGuard-statusLine">
                        {sessions.length} known session{sessions.length === 1 ? "" : "s"}
                        {state?.baselined ? "" : " · awaiting first baseline"}
                        {" · "}last check {formatWhen(state?.lastCheckAt ?? null)}
                    </div>
                    {state?.lastError && (
                        <div className="vc-sessionGuard-error">Last error: {state.lastError}</div>
                    )}
                    {message && <div className="vc-sessionGuard-statusLine">{message}</div>}
                </div>
                <Flex className="vc-sessionGuard-actions">
                    <Button
                        disabled={busy}
                        onClick={() => void run(async () => {
                            const r = await checkSessions({ forceAlert: true });
                            const parts = [`${r.total} live session(s)`];
                            if (r.newSessions.length) parts.push(`${r.newSessions.length} new`);
                            if (r.goneSessions.length) parts.push(`${r.goneSessions.length} gone`);
                            if (r.autoLoggedOut) parts.push(`${r.autoLoggedOut} auto-logged out`);
                            return parts.join(" · ");
                        })}
                    >
                        {busy ? "Working…" : "Check now"}
                    </Button>
                    <Button
                        color={Button.Colors.TRANSPARENT}
                        disabled={busy}
                        onClick={() => {
                            try {
                                SettingsRouter.openUserSettings("sessions_panel");
                            } catch {
                                Toasts.show({
                                    message: "Could not open Devices settings.",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.FAILURE
                                });
                            }
                        }}
                    >
                        Open Devices
                    </Button>
                </Flex>
            </div>

            <div className="vc-sessionGuard-warn">
                First check after install only records a baseline (no alert). After that, any new login device triggers a notification.
                Optional auto-logout will kill untrusted sessions as soon as they appear — use carefully.
            </div>

            <div className="vc-sessionGuard-panel">
                <Forms.FormTitle tag="h5" className="vc-sessionGuard-panelTitle">Known sessions</Forms.FormTitle>
                {sessions.length === 0
                    ? <div className="vc-sessionGuard-empty">No sessions cached yet. Click “Check now”.</div>
                    : (
                        <div className="vc-sessionGuard-list">
                            {sessions.map(s => (
                                <SessionRow
                                    key={s.idHash}
                                    session={s}
                                    busy={busy}
                                    onChanged={() => setVersion(v => v + 1)}
                                />
                            ))}
                        </div>
                    )}
                <Flex className="vc-sessionGuard-actions" style={{ marginTop: 10 }}>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.TRANSPARENT}
                        disabled={busy || !sessions.length}
                        onClick={() => void run(async () => {
                            const n = await trustAllCurrentSessions();
                            return n ? `Trusted ${n} session(s).` : "All sessions already trusted.";
                        })}
                    >
                        Trust all
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.TRANSPARENT}
                        disabled={busy}
                        onClick={() => void run(async () => {
                            const n = await rebaselineFromServer();
                            return `Re-baselined ${n} session(s) as trusted.`;
                        })}
                    >
                        Re-baseline
                    </Button>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.RED}
                        disabled={busy}
                        onClick={() => {
                            openModal(props => (
                                <ConfirmModal
                                    {...props}
                                    title="Log out other sessions?"
                                    confirmText="Log out others"
                                    cancelText="Cancel"
                                    variant="danger"
                                    onConfirm={() => void run(async () => {
                                        const n = await logoutAllOtherSessions();
                                        return n
                                            ? `Logged out ${n} other session(s).`
                                            : "No other sessions to log out.";
                                    })}
                                >
                                    Keeps the most recently active session (usually this client) and invalidates the rest.
                                    You may need to sign in again on other devices.
                                </ConfirmModal>
                            ));
                        }}
                    >
                        Log out others
                    </Button>
                </Flex>
            </div>

            <div className="vc-sessionGuard-panel">
                <div className="vc-sessionGuard-header">
                    <Forms.FormTitle tag="h5" className="vc-sessionGuard-panelTitle">Event history</Forms.FormTitle>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.TRANSPARENT}
                        disabled={busy || !events.length}
                        onClick={() => void run(async () => {
                            await clearEventHistory();
                            return "History cleared.";
                        })}
                    >
                        Clear
                    </Button>
                </div>
                {events.length === 0
                    ? <div className="vc-sessionGuard-empty">No events yet.</div>
                    : (
                        <div className="vc-sessionGuard-list">
                            {events.slice(0, 40).map(ev => (
                                <div
                                    key={ev.id}
                                    className={`vc-sessionGuard-event vc-sessionGuard-eventType-${ev.type}`}
                                >
                                    <div className="vc-sessionGuard-eventTime">{formatClock(ev.at)}</div>
                                    <div className="vc-sessionGuard-eventBody">
                                        <div className="vc-sessionGuard-eventLabel">{eventTitle(ev)}</div>
                                        {ev.label && <div>{ev.label}</div>}
                                        {ev.detail && <div className="vc-sessionGuard-eventDetail">{ev.detail}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
            </div>
        </div>
    );
}
