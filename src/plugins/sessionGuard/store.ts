/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";
import { Constants, RestAPI, SettingsRouter, UserStore } from "@webpack/common";

import {
    DiscordAuthSession,
    KnownSession,
    parseLastUsed,
    SessionEvent,
    SessionGuardState,
    sessionLabel
} from "./types";

const logger = new Logger("SessionGuard");
const DATA_KEY_PREFIX = "SessionGuard_state_v1_";
const MAX_EVENTS = 80;

const SoundModule = findByPropsLazy("playNotificationSound") as {
    playNotificationSound?(sound: string, volume?: number): void;
};

export type SessionGuardSettingsAccess = {
    notifyOnNew: boolean;
    notifyOnGone: boolean;
    permanentNotifications: boolean;
    playSound: boolean;
    nativeNotifications: "default" | "always" | "not-focused" | "never";
    autoLogoutUnknown: boolean;
    openDevicesOnClick: boolean;
};

let settingsAccess: SessionGuardSettingsAccess = {
    notifyOnNew: true,
    notifyOnGone: false,
    permanentNotifications: true,
    playSound: true,
    nativeNotifications: "always",
    autoLogoutUnknown: false,
    openDevicesOnClick: true,
};

let state: SessionGuardState | null = null;
let persistPromise: Promise<void> | null = null;
let checking = false;
const listeners = new Set<() => void>();

function dataKey(userId: string) {
    return `${DATA_KEY_PREFIX}${userId}`;
}

function genId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyState(userId: string): SessionGuardState {
    return {
        userId,
        baselined: false,
        known: {},
        events: [],
        lastCheckAt: null,
        lastError: null
    };
}

function notifyListeners() {
    for (const l of listeners) l();
}

export function subscribeSessionGuard(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSessionGuardState(): SessionGuardState | null {
    return state;
}

export function setSessionGuardSettingsAccess(next: SessionGuardSettingsAccess) {
    settingsAccess = next;
}

async function persist() {
    if (!state) return;
    if (persistPromise) {
        await persistPromise;
        return;
    }

    const snapshot = state;
    persistPromise = DataStore.set(dataKey(snapshot.userId), snapshot)
        .catch(e => logger.warn("persist failed", e))
        .finally(() => {
            persistPromise = null;
        });

    await persistPromise;
}

function pushEvent(partial: Omit<SessionEvent, "id" | "at"> & { at?: number; }) {
    if (!state) return;
    state.events.unshift({
        id: genId(),
        at: partial.at ?? Date.now(),
        type: partial.type,
        idHash: partial.idHash,
        label: partial.label,
        detail: partial.detail
    });
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function playAlertSound() {
    if (!settingsAccess.playSound) return;
    try {
        SoundModule?.playNotificationSound?.("message2");
        // A second chime for urgency after a short delay.
        setTimeout(() => SoundModule?.playNotificationSound?.("message1"), 400);
    } catch (e) {
        logger.debug("playAlertSound failed", e);
    }
}

function nativeOverride() {
    const v = settingsAccess.nativeNotifications;
    return v === "default" ? undefined : v;
}

function alertNewSession(session: KnownSession) {
    if (!settingsAccess.notifyOnNew) return;

    const label = sessionLabel(session);
    showNotification({
        title: "⚠️ New Discord session",
        body: `${label}\nIf this wasn't you, open Devices and log it out.`,
        permanent: settingsAccess.permanentNotifications,
        useNative: nativeOverride(),
        onClick: () => {
            if (settingsAccess.openDevicesOnClick) {
                try {
                    SettingsRouter.openUserSettings("sessions_panel");
                } catch (e) {
                    logger.warn("open sessions_panel failed", e);
                }
            }
        }
    });
    playAlertSound();
}

function alertGoneSession(session: KnownSession) {
    if (!settingsAccess.notifyOnGone) return;

    showNotification({
        title: "Session ended",
        body: sessionLabel(session),
        permanent: false,
        useNative: nativeOverride(),
    });
}

export async function loadSessionGuardState(userId?: string | null) {
    const id = userId ?? UserStore.getCurrentUser()?.id;
    if (!id) {
        state = null;
        notifyListeners();
        return null;
    }

    if (state?.userId === id) return state;

    try {
        const stored = await DataStore.get<SessionGuardState>(dataKey(id));
        if (stored && stored.userId === id && stored.known && typeof stored.known === "object") {
            state = {
                userId: id,
                baselined: Boolean(stored.baselined),
                known: stored.known,
                events: Array.isArray(stored.events) ? stored.events.slice(0, MAX_EVENTS) : [],
                lastCheckAt: typeof stored.lastCheckAt === "number" ? stored.lastCheckAt : null,
                lastError: typeof stored.lastError === "string" ? stored.lastError : null
            };
        } else {
            state = emptyState(id);
        }
    } catch (e) {
        logger.warn("loadSessionGuardState failed", e);
        state = emptyState(id);
    }

    notifyListeners();
    return state;
}

async function fetchSessions(): Promise<DiscordAuthSession[]> {
    const data = await RestAPI.get({
        url: Constants.Endpoints.AUTH_SESSIONS
    });

    const list = data?.body?.user_sessions;
    if (!Array.isArray(list)) {
        throw new Error("Unexpected sessions response from Discord.");
    }

    return list as DiscordAuthSession[];
}

function toKnown(session: DiscordAuthSession, firstSeenAt: number, trusted: boolean): KnownSession {
    return {
        idHash: session.id_hash,
        os: session.client_info?.os ?? "Unknown",
        platform: session.client_info?.platform ?? "Unknown",
        location: session.client_info?.location ?? "",
        firstSeenAt,
        lastUsedAt: parseLastUsed(session.approx_last_used_time),
        trusted
    };
}

/**
 * Logout remote sessions by id_hash. Does not include the current session unless you pass it.
 * API: POST /auth/sessions/logout { session_id_hashes: string[] }
 */
export async function logoutSessions(idHashes: string[]): Promise<number> {
    const unique = [...new Set(idHashes.filter(Boolean))];
    if (!unique.length) return 0;

    // Discord allows 1–64 hashes per call.
    let total = 0;
    for (let i = 0; i < unique.length; i += 64) {
        const chunk = unique.slice(i, i + 64);
        await RestAPI.post({
            url: `${Constants.Endpoints.AUTH_SESSIONS}/logout`,
            body: { session_id_hashes: chunk }
        });
        total += chunk.length;
    }

    if (state) {
        for (const hash of unique) {
            const known = state.known[hash];
            if (known) {
                pushEvent({
                    type: "logout",
                    idHash: hash,
                    label: sessionLabel(known),
                    detail: "Logged out remotely"
                });
                delete state.known[hash];
            }
        }
        await persist();
        notifyListeners();
    }

    return total;
}

export async function logoutAllOtherSessions(): Promise<number> {
    await loadSessionGuardState();
    if (!state) throw new Error("Not logged in.");

    const sessions = await fetchSessions();
    // We cannot perfectly know "current" id_hash from REST alone without gateway ready hash.
    // Logout everything we know except... we logout ALL listed sessions that Discord returns
    // except we skip nothing if API logs out others only — Discord's logout endpoint invalidates
    // the hashes you send; the current session remains if not included.
    // BetterSessions / client UI usually logout selected devices. User asked to kill others —
    // without current hash we logout all returned sessions that are not "just" one if only one exists.
    // Heuristic: logout all known trusted/untrusted except leave the single most recently used session
    // when only checking remotely. Safer approach: logout every session except the most recently used.

    if (sessions.length <= 1) return 0;

    const sorted = [...sessions].sort(
        (a, b) => parseLastUsed(b.approx_last_used_time) - parseLastUsed(a.approx_last_used_time)
    );
    // Keep the most recently active session (likely this client).
    const toKill = sorted.slice(1).map(s => s.id_hash);
    return logoutSessions(toKill);
}

export async function trustSession(idHash: string) {
    await loadSessionGuardState();
    if (!state?.known[idHash]) return;
    state.known[idHash].trusted = true;
    pushEvent({
        type: "trusted",
        idHash,
        label: sessionLabel(state.known[idHash]),
        detail: "Marked as trusted"
    });
    await persist();
    notifyListeners();
}

export async function trustAllCurrentSessions() {
    await loadSessionGuardState();
    if (!state) return 0;

    let n = 0;
    for (const s of Object.values(state.known)) {
        if (!s.trusted) {
            s.trusted = true;
            n++;
        }
    }
    pushEvent({
        type: "trusted",
        detail: n ? `Trusted ${n} session(s)` : "All sessions already trusted"
    });
    await persist();
    notifyListeners();
    return n;
}

export async function clearEventHistory() {
    await loadSessionGuardState();
    if (!state) return;
    state.events = [];
    await persist();
    notifyListeners();
}

export async function rebaselineFromServer() {
    await loadSessionGuardState();
    if (!state) throw new Error("Not logged in.");

    const sessions = await fetchSessions();
    const now = Date.now();
    const known: Record<string, KnownSession> = {};
    for (const s of sessions) {
        known[s.id_hash] = toKnown(s, now, true);
    }
    state.known = known;
    state.baselined = true;
    state.lastCheckAt = now;
    state.lastError = null;
    pushEvent({
        type: "baseline",
        detail: `Trusted ${sessions.length} current session(s) as baseline`
    });
    await persist();
    notifyListeners();
    return sessions.length;
}

export interface CheckResult {
    newSessions: KnownSession[];
    goneSessions: KnownSession[];
    total: number;
    baselined: boolean;
    autoLoggedOut: number;
}

/**
 * Fetch sessions from Discord, compare to known set, alert on unknowns.
 * First successful check only baselines (no alert) unless already baselined.
 */
export async function checkSessions(options?: { forceAlert?: boolean; }): Promise<CheckResult> {
    if (checking) {
        return { newSessions: [], goneSessions: [], total: state ? Object.keys(state.known).length : 0, baselined: Boolean(state?.baselined), autoLoggedOut: 0 };
    }

    checking = true;
    try {
        await loadSessionGuardState();
        if (!state) throw new Error("Not logged in.");

        const sessions = await fetchSessions();
        const now = Date.now();
        const liveHashes = new Set(sessions.map(s => s.id_hash));
        const result: CheckResult = {
            newSessions: [],
            goneSessions: [],
            total: sessions.length,
            baselined: state.baselined,
            autoLoggedOut: 0
        };

        // First run: seed without alerts.
        if (!state.baselined) {
            for (const s of sessions) {
                state.known[s.id_hash] = toKnown(s, now, true);
            }
            state.baselined = true;
            state.lastCheckAt = now;
            state.lastError = null;
            pushEvent({
                type: "baseline",
                detail: `Initial baseline: ${sessions.length} session(s)`
            });
            await persist();
            notifyListeners();
            result.baselined = true;
            return result;
        }

        // Detect new
        for (const s of sessions) {
            const existing = state.known[s.id_hash];
            if (!existing) {
                const known = toKnown(s, now, false);
                state.known[s.id_hash] = known;
                result.newSessions.push(known);
                pushEvent({
                    type: "new",
                    idHash: known.idHash,
                    label: sessionLabel(known),
                    detail: "New session detected"
                });
            } else {
                existing.os = s.client_info?.os ?? existing.os;
                existing.platform = s.client_info?.platform ?? existing.platform;
                existing.location = s.client_info?.location ?? existing.location;
                existing.lastUsedAt = parseLastUsed(s.approx_last_used_time);
            }
        }

        // Detect gone
        for (const hash of Object.keys(state.known)) {
            if (!liveHashes.has(hash)) {
                const gone = state.known[hash];
                result.goneSessions.push(gone);
                pushEvent({
                    type: "gone",
                    idHash: hash,
                    label: sessionLabel(gone),
                    detail: "Session no longer listed"
                });
                delete state.known[hash];
            }
        }

        // Alerts + optional auto-logout for untrusted new sessions
        for (const neu of result.newSessions) {
            if (options?.forceAlert || !neu.trusted) {
                alertNewSession(neu);
            }
        }
        for (const gone of result.goneSessions) {
            alertGoneSession(gone);
        }

        if (settingsAccess.autoLogoutUnknown && result.newSessions.length) {
            const hashes = result.newSessions.map(s => s.idHash);
            try {
                result.autoLoggedOut = await logoutSessions(hashes);
                // logoutSessions mutates state; mark events
                pushEvent({
                    type: "logout",
                    detail: `Auto-logged out ${result.autoLoggedOut} unknown session(s)`
                });
            } catch (e) {
                logger.error("autoLogoutUnknown failed", e);
                state.lastError = e instanceof Error ? e.message : "Auto-logout failed";
            }
        }

        state.lastCheckAt = now;
        state.lastError = null;
        pushEvent({
            type: "check",
            detail: `Checked ${sessions.length} session(s)` +
                (result.newSessions.length ? `, ${result.newSessions.length} new` : "") +
                (result.goneSessions.length ? `, ${result.goneSessions.length} gone` : "")
        });

        // Avoid flooding history with pure "check" noise when nothing changed —
        // remove the last check event if it was a no-op and we already have a recent check.
        if (!result.newSessions.length && !result.goneSessions.length && !result.autoLoggedOut) {
            // Keep only one silent check in a row: drop this check event if previous is also check.
            if (state.events[1]?.type === "check") {
                state.events.shift();
            }
        }

        await persist();
        notifyListeners();
        return result;
    } catch (e) {
        const message = e instanceof Error ? e.message : "Session check failed";
        logger.error("checkSessions failed", e);
        if (state) {
            state.lastError = message;
            await persist();
            notifyListeners();
        }
        throw e;
    } finally {
        checking = false;
    }
}
