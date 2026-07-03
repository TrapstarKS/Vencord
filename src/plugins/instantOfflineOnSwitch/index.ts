/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { findByProps } from "@webpack";

const logger = new Logger("InstantOfflineOnSwitch");

const settings = definePluginSettings({
    alsoCleanCloseOnLogout: {
        type: OptionType.BOOLEAN,
        description: "Also drop offline instantly on a normal logout (not only when switching accounts)",
        default: true
    }
});

// --- Why this plugin exists -------------------------------------------------
// When you switch accounts (or log out), Discord tears the gateway WebSocket down by calling
// `ws.close()` WITHOUT a close code. A code-less close reaches the server as a "no status" (1005)
// closure, which the server treats as a possibly-resumable drop: it keeps your session (and thus
// your presence) alive for a grace period (~3 min), so the account you just left lingers ONLINE.
//
// The fix: close the gateway with a normal 1000 code instead. A clean 1000 closure tells the server
// the session is gone for good, so it drops your presence immediately (like an Alt+F4 quit does).
//
// Timing is the tricky part. Discord closes the socket at essentially the same instant it dispatches
// LOGOUT (measured: within a few ms, order not deterministic), so reacting to the LOGOUT flux event
// is too late — by then the socket is already closing and close() is a no-op. Instead we:
//   1) hook the account-switch / logout actions, which run BEFORE the teardown, to "arm" a short window;
//   2) wrap the gateway socket's own close() so that while armed, a code-less close is upgraded to 1000.
// This is targeted: outside the armed window (normal reconnects / RESUME) close() is left untouched.

let OriginalWebSocket: typeof WebSocket | null = null;
let currentGatewaySocket: WebSocket | null = null;
let cleanCloseArmedUntil = 0;
let authHooked = false;

// The teardown happens within a couple ms of the switch/logout action; a few seconds of slack is plenty
// and keeps the "force 1000" behaviour from bleeding into unrelated reconnects.
const ARM_MS = 4000;

function armCleanClose() {
    cleanCloseArmedUntil = Date.now() + ARM_MS;
}

function isArmed() {
    return Date.now() < cleanCloseArmedUntil;
}

function isGatewayUrl(url: string): boolean {
    // e.g. wss://gateway-us-east1-b.discord.gg/?encoding=etf&v=9&compress=zstd-stream
    return /gateway\.discord\.gg|remote-auth-gateway|\bgateway\b/i.test(url);
}

function installWebSocketHook() {
    if (OriginalWebSocket) return;
    OriginalWebSocket = window.WebSocket;

    const Original = OriginalWebSocket;
    class HookedWebSocket extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            try {
                if (!isGatewayUrl(String(url))) return;

                currentGatewaySocket = this;

                // Override this socket's close() so Discord's code-less teardown becomes a clean 1000
                // close while a switch/logout is armed. Native close() is used for everything else.
                const nativeClose = Original.prototype.close;
                (this as WebSocket).close = (code?: number, reason?: string) => {
                    if (isArmed() && code == null) {
                        logger.info("switching/logging out — upgrading gateway close to 1000 (instant offline)");
                        return nativeClose.call(this, 1000, reason ?? "account switch");
                    }
                    return nativeClose.call(this, code as number, reason as string);
                };

                this.addEventListener("close", () => {
                    if (currentGatewaySocket === this) currentGatewaySocket = null;
                });
            } catch (e) {
                logger.error("failed to hook new gateway WebSocket", e);
            }
        }
    }

    window.WebSocket = HookedWebSocket as unknown as typeof WebSocket;
}

function removeWebSocketHook() {
    if (OriginalWebSocket) {
        window.WebSocket = OriginalWebSocket;
        OriginalWebSocket = null;
    }
    currentGatewaySocket = null;
}

/**
 * Wrap Discord's account-switch (`switchAccountToken`) and `logout` actions so we arm the clean-close
 * window the moment a switch/logout begins — before Discord tears the gateway down. The real UI account
 * switcher routes through `switchAccountToken`, so hooking it covers the UI path too (verified live).
 */
function hookAuthActions() {
    if (authHooked) return;

    let auth: any;
    try {
        auth = findByProps("switchAccountToken", "logout");
    } catch {
        return; // webpack not ready yet (Init); CONNECTION_OPEN will retry
    }
    if (!auth || typeof auth.switchAccountToken !== "function" || typeof auth.logout !== "function") return;

    if (!auth.__ioosHooked) {
        const origSwitch = auth.switchAccountToken;
        auth.switchAccountToken = function (this: unknown, ...args: unknown[]) {
            armCleanClose();
            return origSwitch.apply(this, args);
        };

        const origLogout = auth.logout;
        auth.logout = function (this: unknown, ...args: unknown[]) {
            if (settings.store.alsoCleanCloseOnLogout) armCleanClose();
            return origLogout.apply(this, args);
        };

        auth.__ioosHooked = true;
        auth.__ioosOriginals = { switchAccountToken: origSwitch, logout: origLogout };
        logger.info("hooked account switch / logout actions");
    }

    authHooked = true;
}

function unhookAuthActions() {
    try {
        const auth: any = findByProps("switchAccountToken", "logout");
        if (auth?.__ioosHooked && auth.__ioosOriginals) {
            auth.switchAccountToken = auth.__ioosOriginals.switchAccountToken;
            auth.logout = auth.__ioosOriginals.logout;
            delete auth.__ioosHooked;
            delete auth.__ioosOriginals;
        }
    } catch { /* ignore */ }
    authHooked = false;
}

export default definePlugin({
    name: "InstantOfflineOnSwitch",
    description: "Makes your previous account drop offline instantly when you switch accounts (or log out), instead of lingering online for ~3 minutes.",
    tags: ["Utility"],
    authors: [Devs.trapstar],
    settings,

    // Install the WebSocket hook as early as possible so we capture the gateway when it connects on load.
    startAt: StartAt.Init,

    flux: {
        // Ensures the auth actions get hooked once webpack is ready, before any account switch happens.
        CONNECTION_OPEN() {
            hookAuthActions();
        }
    },

    start() {
        installWebSocketHook();
        hookAuthActions();
    },

    stop() {
        unhookAuthActions();
        removeWebSocketHook();
    },

    /** Debug helper (used to verify the hook + arming are in place). */
    getDebugState() {
        return {
            // The class name gets minified, so detect the hook by it not being the native implementation.
            hookInstalled: !/\[native code\]/.test(String(window.WebSocket)),
            authHooked,
            armed: isArmed(),
            hasCapturedSocket: currentGatewaySocket != null,
            readyState: currentGatewaySocket?.readyState ?? null,
            url: (currentGatewaySocket as any)?.url ?? null,
            open: currentGatewaySocket != null && currentGatewaySocket.readyState === (OriginalWebSocket?.OPEN ?? 1)
        };
    }
});
