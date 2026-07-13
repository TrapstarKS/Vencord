/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

import { SessionGuardDashboard } from "./Dashboard";
import {
    checkSessions,
    getSessionGuardState,
    loadSessionGuardState,
    logoutAllOtherSessions,
    rebaselineFromServer,
    setSessionGuardSettingsAccess
} from "./store";

const logger = new Logger("SessionGuard");

const settings = definePluginSettings({
    dashboard: {
        type: OptionType.COMPONENT,
        description: "Live session list, history, and actions",
        component: () => <SessionGuardDashboard />
    },
    enabledPolling: {
        type: OptionType.BOOLEAN,
        description: "Poll Discord for new login sessions in the background",
        default: true
    },
    checkIntervalMinutes: {
        type: OptionType.SLIDER,
        description: "How often to poll for new sessions (minutes)",
        markers: [1, 2, 5, 10, 15, 30, 60],
        default: 5,
        stickToMarkers: false
    },
    checkOnFocus: {
        type: OptionType.BOOLEAN,
        description: "Also check when the Discord window gains focus",
        default: true
    },
    checkOnConnect: {
        type: OptionType.BOOLEAN,
        description: "Check when the gateway connects / reconnects",
        default: true
    },
    notifyOnNew: {
        type: OptionType.BOOLEAN,
        description: "Notify when a new session (device login) appears",
        default: true
    },
    notifyOnGone: {
        type: OptionType.BOOLEAN,
        description: "Notify when a previously known session disappears",
        default: false
    },
    permanentNotifications: {
        type: OptionType.BOOLEAN,
        description: "Keep new-session alerts on screen until dismissed",
        default: true
    },
    playSound: {
        type: OptionType.BOOLEAN,
        description: "Play a notification sound when a new session is detected",
        default: true
    },
    nativeNotifications: {
        type: OptionType.SELECT,
        description: "Native (OS) notifications for session alerts",
        options: [
            { label: "Always (recommended for security)", value: "always", default: true },
            { label: "Use Vencord global setting", value: "default" },
            { label: "Only when Discord isn't focused", value: "not-focused" },
            { label: "Never", value: "never" }
        ]
    },
    openDevicesOnClick: {
        type: OptionType.BOOLEAN,
        description: "Open Discord Devices settings when you click a session alert",
        default: true
    },
    autoLogoutUnknown: {
        type: OptionType.BOOLEAN,
        description: "Automatically log out brand-new untrusted sessions as soon as they appear (aggressive)",
        default: false
    }
}, {
    checkIntervalMinutes: {
        hidden() {
            return !this.store.enabledPolling;
        }
    }
});

function syncSettingsAccess() {
    setSessionGuardSettingsAccess({
        notifyOnNew: settings.store.notifyOnNew,
        notifyOnGone: settings.store.notifyOnGone,
        permanentNotifications: settings.store.permanentNotifications,
        playSound: settings.store.playSound,
        nativeNotifications: settings.store.nativeNotifications as "default" | "always" | "not-focused" | "never",
        autoLogoutUnknown: settings.store.autoLogoutUnknown,
        openDevicesOnClick: settings.store.openDevicesOnClick
    });
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let focusHandler: (() => void) | null = null;

const settingsListeners: Array<[path: string, cb: () => void]> = [
    ["plugins.SessionGuard.enabledPolling", () => { syncSettingsAccess(); schedulePoll(); }],
    ["plugins.SessionGuard.checkIntervalMinutes", () => { schedulePoll(); }],
    ["plugins.SessionGuard.checkOnFocus", () => { installFocusCheck(); }],
    ["plugins.SessionGuard.notifyOnNew", syncSettingsAccess],
    ["plugins.SessionGuard.notifyOnGone", syncSettingsAccess],
    ["plugins.SessionGuard.permanentNotifications", syncSettingsAccess],
    ["plugins.SessionGuard.playSound", syncSettingsAccess],
    ["plugins.SessionGuard.nativeNotifications", syncSettingsAccess],
    ["plugins.SessionGuard.autoLogoutUnknown", syncSettingsAccess],
    ["plugins.SessionGuard.openDevicesOnClick", syncSettingsAccess],
];

function clearPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function schedulePoll() {
    clearPoll();
    if (!settings.store.enabledPolling) return;

    const minutes = Math.max(1, Number(settings.store.checkIntervalMinutes) || 5);
    pollTimer = setInterval(() => {
        void checkSessions().catch(e => logger.warn("poll check failed", e));
    }, minutes * 60_000);
}

function installFocusCheck() {
    removeFocusCheck();
    if (!settings.store.checkOnFocus) return;

    let last = 0;
    focusHandler = () => {
        if (!document.hasFocus()) return;
        const now = Date.now();
        // Debounce: at most once per 30s on focus spam.
        if (now - last < 30_000) return;
        last = now;
        void checkSessions().catch(e => logger.warn("focus check failed", e));
    };
    window.addEventListener("focus", focusHandler);
}

function removeFocusCheck() {
    if (focusHandler) {
        window.removeEventListener("focus", focusHandler);
        focusHandler = null;
    }
}

export default definePlugin({
    name: "SessionGuard",
    description: "Watches Discord login sessions (devices) and alerts you when a new one appears — with history, trust, and remote logout.",
    authors: [Devs.trapstar],
    tags: ["Privacy", "Notifications", "Utility"],
    searchTerms: ["session", "device", "login", "security", "logout", "auth", "hijack"],
    settings,

    commands: [
        {
            name: "sessionguard",
            description: "Session Guard: check devices, status, or log out other sessions",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "check",
                    description: "Fetch sessions now and alert on unknowns",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                },
                {
                    name: "status",
                    description: "Show known session count and last check time",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                },
                {
                    name: "logout-others",
                    description: "Log out every session except the most recently active one",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                },
                {
                    name: "baseline",
                    description: "Trust all current sessions as a new baseline",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                }
            ],
            async execute(args, ctx) {
                const action = args[0]?.name ?? "check";

                try {
                    if (action === "status") {
                        await loadSessionGuardState();
                        const s = getSessionGuardState();
                        const count = s ? Object.keys(s.known).length : 0;
                        const untrusted = s
                            ? Object.values(s.known).filter(x => !x.trusted).length
                            : 0;
                        sendBotMessage(ctx.channel.id, {
                            content:
                                "**Session Guard**\n" +
                                `• Known sessions: **${count}** (${untrusted} untrusted)\n` +
                                `• Baselined: **${s?.baselined ? "yes" : "no"}**\n` +
                                `• Last check: **${s?.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString() : "never"}**\n` +
                                (s?.lastError ? `• Last error: ${s.lastError}\n` : "")
                        });
                        return;
                    }

                    if (action === "logout-others") {
                        const n = await logoutAllOtherSessions();
                        sendBotMessage(ctx.channel.id, {
                            content: n
                                ? `Logged out **${n}** other session(s).`
                                : "No other sessions to log out."
                        });
                        return;
                    }

                    if (action === "baseline") {
                        const n = await rebaselineFromServer();
                        sendBotMessage(ctx.channel.id, {
                            content: `Re-baselined **${n}** session(s) as trusted.`
                        });
                        return;
                    }

                    const r = await checkSessions({ forceAlert: true });
                    sendBotMessage(ctx.channel.id, {
                        content:
                            `Checked **${r.total}** session(s).` +
                            (r.newSessions.length ? ` **${r.newSessions.length}** new.` : " No new sessions.") +
                            (r.goneSessions.length ? ` **${r.goneSessions.length}** gone.` : "") +
                            (r.autoLoggedOut ? ` Auto-logged out **${r.autoLoggedOut}**.` : "")
                    });
                } catch (e) {
                    sendBotMessage(ctx.channel.id, {
                        content: `Session Guard error: ${e instanceof Error ? e.message : "unknown"}`
                    });
                }
            }
        }
    ],

    flux: {
        CONNECTION_OPEN() {
            if (!settings.store.checkOnConnect) return;
            void loadSessionGuardState()
                .then(() => checkSessions())
                .catch(e => logger.warn("connect check failed", e));
        },
        // Multi-account: reload state for the new user and baseline if needed.
        CURRENT_USER_UPDATE() {
            void loadSessionGuardState()
                .then(() => {
                    if (settings.store.checkOnConnect) return checkSessions();
                })
                .catch(e => logger.warn("user switch check failed", e));
        }
    },

    start() {
        syncSettingsAccess();
        for (const [path, cb] of settingsListeners) SettingsStore.addChangeListener(path, cb);

        void loadSessionGuardState()
            .then(() => checkSessions())
            .catch(e => logger.warn("initial check failed", e));

        schedulePoll();
        installFocusCheck();
    },

    stop() {
        clearPoll();
        removeFocusCheck();
        for (const [path, cb] of settingsListeners) SettingsStore.removeChangeListener(path, cb);
    }
});
