/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTH_MS = DAY_MS * 30;
const YEAR_MS = DAY_MS * 365;

export function fmt_time(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < MIN_MS) return "now";
    if (diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)}m`;
    if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
    if (diff < MONTH_MS) return `${Math.floor(diff / DAY_MS)}d`;
    if (diff < YEAR_MS) return `${Math.floor(diff / MONTH_MS)}mo`;
    return `${Math.floor(diff / YEAR_MS)}y`;
}

export function fmt_time_full(ts: string): string {
    return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function fmt_bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function hostname(url?: string): string {
    if (!url) return "";
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
}
