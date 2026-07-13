/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface SessionClientInfo {
    os: string;
    platform: string;
    location: string;
}

export interface DiscordAuthSession {
    id_hash: string;
    approx_last_used_time: string | number | Date;
    client_info: SessionClientInfo;
}

export interface KnownSession {
    idHash: string;
    os: string;
    platform: string;
    location: string;
    /** When we first saw this session (local). */
    firstSeenAt: number;
    /** Last time Discord reported activity (approx). */
    lastUsedAt: number;
    /** User explicitly trusted / dismissed alert. */
    trusted: boolean;
}

export type SessionEventType = "baseline" | "new" | "gone" | "trusted" | "logout" | "check";

export interface SessionEvent {
    id: string;
    type: SessionEventType;
    at: number;
    idHash?: string;
    label?: string;
    detail?: string;
}

export interface SessionGuardState {
    /** User id this state belongs to (multi-account safe). */
    userId: string;
    /** True after the first successful fetch seeded known sessions without alerts. */
    baselined: boolean;
    known: Record<string, KnownSession>;
    events: SessionEvent[];
    lastCheckAt: number | null;
    lastError: string | null;
}

export function sessionLabel(session: Pick<KnownSession, "os" | "platform" | "location"> | SessionClientInfo): string {
    const os = "os" in session ? session.os : (session as SessionClientInfo).os;
    const platform = "platform" in session ? session.platform : (session as SessionClientInfo).platform;
    const location = "location" in session ? session.location : (session as SessionClientInfo).location;
    return [os, platform, location].filter(Boolean).join(" · ") || "Unknown device";
}

export function parseLastUsed(value: DiscordAuthSession["approx_last_used_time"]): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? t : Date.now();
}
