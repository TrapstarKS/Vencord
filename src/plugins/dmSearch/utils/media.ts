/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageHit } from "@plugins/dmSearch/types";

export interface Thumb {
    key: string;
    src: string;
    video: boolean;
}

const MEDIA_EMBED_TYPES = new Set(["image", "gifv", "video"]);

export function media_thumbs(hit: MessageHit): Thumb[] {
    const out: Thumb[] = [];
    for (const a of hit.attachments ?? []) {
        if (a.content_type?.startsWith?.("image/")) out.push({ key: a.id, src: a.proxy_url, video: false });
        else if (a.content_type?.startsWith?.("video/")) out.push({ key: a.id, src: a.proxy_url, video: true });
    }
    // Media hits are often link-based (Tenor GIFs, image links, YouTube) and carry no attachment —
    // only an embed with a preview image. Fall back to the embed thumbnail so they aren't blank.
    (hit.embeds ?? []).forEach((e, i) => {
        if (!MEDIA_EMBED_TYPES.has(e.type ?? "")) return;
        const src = e.image?.proxy_url ?? e.thumbnail?.proxy_url;
        if (src) out.push({ key: `e${i}`, src, video: false });
    });
    return out;
}
