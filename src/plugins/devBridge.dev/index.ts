/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pluginRequiresRestart, plugins as Plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { definePluginSettings, Settings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

// DevBridge — local development tool.
//
// Long-polls a local HTTP server (127.0.0.1) for JS snippets, evaluates them in the Discord renderer,
// and posts the result back. This lets a local process (e.g. a script on your machine) drive Discord's
// webpack (Vencord.Webpack.search/extract/wreq), inspect the DOM, and test patch ideas against the live
// bundle without copy-pasting into the console.
//
// Security: connects ONLY to 127.0.0.1 (loopback), which is a "potentially trustworthy" origin and thus
// exempt from mixed-content blocking. This is the same localhost-only remote-eval model the built-in
// DevCompanion plugin already uses. Only enable it while developing; disable it when you're done.

const logger = new Logger("DevBridge");

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Local port of the DevBridge server to poll (127.0.0.1)",
        default: 8486
    },
    logCommands: {
        type: OptionType.BOOLEAN,
        description: "Log each received command to the console",
        default: true
    }
});

let running = false;

// --- Plugin control helpers ($dev) -----------------------------------------
// Exposed on window.$dev so an eval'd snippet (or the DevTools console) can flip plugins on/off at
// runtime without rebuilding — handy for A/B testing a plugin against the live bundle. Plugins with
// patches can't be fully (de)applied without a reload, so those return a note instead.
function pluginByName(name: string) {
    const p = Plugins[name];
    if (!p) throw new Error(`No plugin named "${name}". Use $dev.list() to see available names.`);
    return p;
}

function setPluginEnabled(name: string, enabled: boolean) {
    const p = pluginByName(name);
    Settings.plugins[name].enabled = enabled;

    const needsRestart = pluginRequiresRestart(p);
    let ran: boolean | null = null;
    if (!needsRestart) ran = enabled ? startPlugin(p) : stopPlugin(p);

    return {
        name,
        enabled,
        started: !!p.started,
        requiresRestart: needsRestart,
        ran,
        note: needsRestart ? "This plugin has patches — reload Discord ($dev.reload()) to fully apply." : undefined
    };
}

const devApi = {
    /** List every plugin with its enabled/started state. */
    list: () => Object.values(Plugins).map(p => ({
        name: p.name,
        enabled: !!Settings.plugins[p.name]?.enabled,
        started: !!p.started,
        requiresRestart: pluginRequiresRestart(p)
    })),
    /** State of a single plugin. */
    state: (name: string) => {
        const p = pluginByName(name);
        return { name, enabled: !!Settings.plugins[name]?.enabled, started: !!p.started, requiresRestart: pluginRequiresRestart(p) };
    },
    enable: (name: string) => setPluginEnabled(name, true),
    disable: (name: string) => setPluginEnabled(name, false),
    toggle: (name: string) => setPluginEnabled(name, !Settings.plugins[name]?.enabled),
    /** Stop then start a plugin (no-op safe if it wasn't started). */
    restart: (name: string) => {
        const p = pluginByName(name);
        if (p.started) stopPlugin(p);
        const ran = startPlugin(p);
        return { name, restarted: ran, started: !!p.started };
    },
    /** Reload the Discord renderer (picks up a fresh build). */
    reload: () => location.reload()
};

function installDevApi() {
    (window as any).$dev = devApi;
}

function removeDevApi() {
    if ((window as any).$dev === devApi) delete (window as any).$dev;
}

function base() {
    return `http://127.0.0.1:${settings.store.port}`;
}

function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms));
}

async function evalCode(code: string): Promise<unknown> {
    // Runs in global scope, so `window`, `document`, and `Vencord` are all reachable.
    // `code` is a function body and must `return` its value (a Promise is awaited).
    const fn = new Function(`return (async () => { ${code} })();`);
    return await fn();
}

function safePayload(nonce: string, result: unknown) {
    let body: string;
    try {
        body = JSON.stringify({ nonce, ok: true, result });
    } catch {
        // Non-serializable (functions / circular): fall back to a string form so we still get something back.
        body = JSON.stringify({ nonce, ok: true, result: String(result), note: "non-serializable, coerced to string" });
    }
    return body;
}

async function loop() {
    logger.info("DevBridge loop started; polling", base());

    while (running) {
        let cmd: { nonce?: string | null; code?: string; } | null = null;

        try {
            const res = await fetch(base() + "/poll", { method: "GET", cache: "no-store" });
            if (!res.ok) {
                await sleep(1000);
                continue;
            }
            cmd = await res.json();
        } catch {
            // Server not up yet / transient — back off and retry.
            await sleep(1500);
            continue;
        }

        // Long-poll timeout, loop again. The small sleep caps this at ~20 req/s in case a
        // misbehaving server answers instantly with an empty 200 (would busy-loop otherwise).
        if (!cmd || cmd.nonce == null || typeof cmd.code !== "string") { await sleep(50); continue; }

        if (settings.store.logCommands) logger.info("cmd", cmd.nonce, "\n", cmd.code);

        let body: string;
        try {
            const result = await evalCode(cmd.code);
            body = safePayload(cmd.nonce, result);
        } catch (e: any) {
            body = JSON.stringify({ nonce: cmd.nonce, ok: false, error: String(e?.stack ?? e) });
        }

        try {
            await fetch(base() + "/result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body
            });
        } catch (e) {
            logger.error("failed to post result", e);
        }
    }

    logger.info("DevBridge loop stopped");
}

export default definePlugin({
    name: "DevBridge",
    description: "Dev tool: evaluates JS snippets from a local (127.0.0.1) HTTP server so a local process can drive the live Discord bundle, and exposes window.$dev to enable/disable/toggle/restart plugins at runtime. Enable only while developing.",
    tags: ["Developers", "Utility"],
    authors: [Devs.trapstar],
    settings,

    start() {
        running = true;
        installDevApi();
        void loop();
    },

    stop() {
        running = false;
        removeDevApi();
    }
});
