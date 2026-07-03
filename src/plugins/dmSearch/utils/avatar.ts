/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function avatar_url(user_id?: string, hash?: string | null): string {
    if (!user_id) return fallback(0);
    if (!hash) return fallback(default_index(user_id));
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user_id}/${hash}.${ext}?size=80`;
}

// Default avatar bucket for a user with no avatar. Modern (pomelo) accounts use (id >> 22) % 6;
// parseInt on a snowflake overflows Number and loses precision, so operate on the id as a BigInt.
function default_index(user_id: string): number {
    try {
        return Number((BigInt(user_id) >> 22n) % 6n);
    } catch {
        return 0;
    }
}

function fallback(idx: number): string {
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png?size=80`;
}
