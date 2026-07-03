/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

// Zero-width / invisible / bidi-control / soft-hyphen code points commonly used for
// fingerprinting, hidden watermarking or invisible-ink tricks. Built from an ASCII
// code-point list so no literal invisible characters live in this source file.
// U+00AD soft hyphen, U+061C Arabic letter mark, U+180E, U+200B-200F (ZWSP/ZWNJ/ZWJ/LRM/RLM),
// U+202A-202E (bidi embeddings/overrides), U+2060-2064, U+206A-206F, U+FEFF (BOM/ZWNBSP).
const INVISIBLE_CODEPOINTS = [
    0x00AD, 0x061C, 0x180E,
    0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
    0xFEFF
];
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CODEPOINTS.map(c => "\\u" + c.toString(16).padStart(4, "0")).join("")}]`, "g");
// Unicode "tag" block (U+E0000-U+E007F) — used to smuggle hidden ASCII into text.
const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/gu;

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg)\/[^\s/]+/gi;

// Common tracking / analytics query params.
const TRACKING_PARAMS = [
    /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gclsrc$/i, /^gbraid$/i, /^wbraid$/i,
    /^msclkid$/i, /^mc_eid$/i, /^mc_cid$/i, /^igshid$/i, /^igsh$/i, /^ref$/i, /^ref_src$/i,
    /^ref_url$/i, /^referrer$/i, /^_ga$/i, /^yclid$/i, /^si$/i, /^spm$/i,
    /^vero_id$/i, /^oly_enc_id$/i, /^oly_anon_id$/i, /^_openstat$/i, /^wickedid$/i, /^twclid$/i,
    /^__s$/i, /^cmpid$/i, /^campaign_id$/i, /^ttclid$/i, /^trk$/i, /^trkCampaign$/i
];

const settings = definePluginSettings({
    stripInvisible: {
        type: OptionType.BOOLEAN,
        description: "Strip zero-width, bidi-control and other invisible/hidden Unicode characters",
        default: true
    },
    stripUnicodeTags: {
        type: OptionType.BOOLEAN,
        description: "Strip smuggled Unicode tag characters (hidden ASCII payloads)",
        default: true
    },
    stripTracking: {
        type: OptionType.BOOLEAN,
        description: "Remove tracking parameters (utm_*, fbclid, …) from URLs in your message. Leave off if you already use ClearURLs.",
        default: false
    },
    flagInvites: {
        type: OptionType.BOOLEAN,
        description: "Warn (via toast) when your message contains a server-invite link",
        default: true
    },
    showSummary: {
        type: OptionType.BOOLEAN,
        description: "Show a toast summarizing what was cleaned",
        default: true
    }
});

function stripTrackingParams(content: string, report: string[]): string {
    if (!/https?:\/\//i.test(content)) return content;

    let removed = 0;
    const cleaned = content.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"'>)|\]])/g, match => {
        let url: URL;
        try {
            url = new URL(match);
        } catch {
            return match;
        }
        if ([...url.searchParams.keys()].length === 0) return match;

        const toDelete: string[] = [];
        url.searchParams.forEach((_, key) => {
            if (TRACKING_PARAMS.some(rule => rule.test(key))) toDelete.push(key);
        });
        for (const key of toDelete) {
            url.searchParams.delete(key);
            removed++;
        }
        return url.toString();
    });

    if (removed > 0) report.push(`${removed} tracking param${removed === 1 ? "" : "s"}`);
    return cleaned;
}

function sanitize(msg: MessageObject) {
    if (!msg.content) return;

    let { content } = msg;
    const report: string[] = [];

    if (settings.store.stripInvisible) {
        const count = (content.match(INVISIBLE_RE) ?? []).length;
        if (count > 0) {
            content = content.replace(INVISIBLE_RE, "");
            report.push(`${count} invisible char${count === 1 ? "" : "s"}`);
        }
    }

    if (settings.store.stripUnicodeTags) {
        const count = (content.match(UNICODE_TAG_RE) ?? []).length;
        if (count > 0) {
            content = content.replace(UNICODE_TAG_RE, "");
            report.push(`${count} hidden tag char${count === 1 ? "" : "s"}`);
        }
    }

    if (settings.store.stripTracking) {
        content = stripTrackingParams(content, report);
    }

    msg.content = content;

    if (settings.store.flagInvites) {
        const invites = content.match(INVITE_RE);
        if (invites?.length) report.push(`${invites.length} invite link${invites.length === 1 ? "" : "s"} detected`);
    }

    if (report.length && settings.store.showSummary) {
        showToast(`ClipboardSanitizer: ${report.join(", ")}`, Toasts.Type.SUCCESS);
    }
}

export default definePlugin({
    name: "ClipboardSanitizer",
    description: "Cleans your outgoing messages: strips invisible/hidden Unicode characters, optionally removes URL tracking params, and warns about invite links.",
    authors: [Devs.trapstar],
    tags: ["Privacy", "Chat"],
    searchTerms: ["unicode", "zero-width", "tracking", "clean", "invisible"],
    settings,

    onBeforeMessageSend(_, msg) {
        sanitize(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        sanitize(msg);
    }
});
