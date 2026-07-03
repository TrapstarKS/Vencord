/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

const logger = new Logger("NoReconnectSound");

// Discord plays a "connected" chime every time the gateway (re)connects — on app start, on reconnect,
// and (annoyingly) on every account switch. It fires ~0.1-0.9s AFTER the CONNECTION_OPEN flux event
// (measured live). We can't reliably match the sound by asset name (the hashed .mp3 filename changes
// between Discord builds), so instead we mute URL-based <audio> playback for a short window right after
// each CONNECTION_OPEN. Voice chat uses MediaStream (srcObject), not a URL, so it's left untouched; any
// unrelated notification sound only happens to be muted if it lands within ~1.5s of a (re)connect.

const WINDOW_MS = 1500;

let suppressUntil = 0;
let originalPlay: typeof HTMLMediaElement.prototype.play | null = null;

export default definePlugin({
    name: "NoReconnectSound",
    description: "Silences Discord's connect/reconnect chime that plays on startup, reconnects, and account switches.",
    tags: ["Utility", "Notifications"],
    authors: [Devs.trapstar],

    flux: {
        CONNECTION_OPEN() {
            suppressUntil = Date.now() + WINDOW_MS;
        }
    },

    start() {
        if (originalPlay) return;
        originalPlay = HTMLMediaElement.prototype.play;
        const nativePlay = originalPlay;

        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            const isUrlAudio = !!(this.src || this.currentSrc) && !this.srcObject;
            if (isUrlAudio && Date.now() < suppressUntil) {
                // Swallow the (re)connect chime; return a resolved promise so callers awaiting play() don't break.
                return Promise.resolve();
            }
            return nativePlay.apply(this, arguments as any);
        };

        logger.info("connect/reconnect chime will be muted for", WINDOW_MS, "ms after each gateway connect");
    },

    stop() {
        if (originalPlay) {
            HTMLMediaElement.prototype.play = originalPlay;
            originalPlay = null;
        }
        suppressUntil = 0;
    }
});
