/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Forms, React, Toasts, useState } from "@webpack/common";

import { getRestoreStats, loadSavedAccounts, restoreHiddenAccounts, saveCurrentAccounts, storageReady } from "./accounts";

let autoRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let autoRestoreAttempts = 0;
let autoRestoreRunning = false;

function RestoreSection() {
    const [busy, setBusy] = useState(false);
    const [stats, setStats] = useState(() => getRestoreStats(settings.store.maxAccounts));
    const [message, setMessage] = useState<string | null>(null);
    const ready = storageReady();

    function refresh() {
        setStats(getRestoreStats(settings.store.maxAccounts));
    }

    React.useEffect(() => {
        let alive = true;

        loadSavedAccounts().then(() => {
            if (alive) refresh();
        }).catch(() => void 0);

        return () => void (alive = false);
    }, []);

    async function run() {
        setBusy(true);
        setMessage(null);

        try {
            const r = await restoreHiddenAccounts(settings.store.maxAccounts);
            const parts = [`Restored ${r.added} account(s)`];

            if (r.valid) parts.push(`${r.valid} valid`);
            if (r.unknown) parts.push(`${r.unknown} restored without fresh validation`);
            if (r.expired) parts.push(`${r.expired} need login`);
            if (r.skippedLimit) parts.push(`${r.skippedLimit} skipped by limit`);
            if (r.skippedNoToken) parts.push(`${r.skippedNoToken} missing token`);
            if (r.skippedMismatch) parts.push(`${r.skippedMismatch} token mismatch`);

            setMessage(parts.join(", "));
            refresh();
        } catch {
            setMessage("Restore failed, check the console.");
        } finally {
            setBusy(false);
        }
    }

    async function saveNow() {
        setBusy(true);
        setMessage(null);

        try {
            await saveCurrentAccounts();
            refresh();
            setMessage("Current switcher accounts saved for future recovery.");
        } catch {
            setMessage("Save failed, check the console.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section>
            <Forms.FormTitle>Account recovery</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                {!ready
                    ? "Couldn't reach Discord's saved account tokens yet."
                    : stats.hidden > 0
                        ? `${stats.hidden} hidden account(s) can be restored. ${stats.capacity} slot(s) free with the current limit.`
                        : stats.withoutToken > 0
                            ? `${stats.saved} account(s) saved locally, but ${stats.withoutToken} do not have a Discord token saved anymore.`
                            : `${stats.inSwitcher} account(s) in the switcher, ${stats.saved} saved for future recovery.`}
            </Forms.FormText>
            <Flex>
                <Button onClick={run} disabled={busy || !ready || stats.hidden === 0 || stats.capacity === 0}>
                    {busy ? "Working..." : stats.hidden > 0 ? `Restore ${Math.min(stats.hidden, stats.capacity)} account${Math.min(stats.hidden, stats.capacity) === 1 ? "" : "s"}` : "Nothing to restore"}
                </Button>
                <Button onClick={saveNow} disabled={busy} color={Button.Colors.TRANSPARENT}>
                    Save current accounts
                </Button>
            </Flex>
            {message && <Forms.FormText style={{ marginTop: 8 }}>{message}</Forms.FormText>}
        </section>
    );
}

const settings = definePluginSettings({
    maxAccounts: {
        type: OptionType.NUMBER,
        description: "Max accounts in the switcher. Setting this below your current count logs the extras out",
        default: 50
    },
    autoRestore: {
        type: OptionType.BOOLEAN,
        description: "Automatically save visible accounts and re-add hidden ones when Discord connects",
        default: true
    },
    restore: {
        type: OptionType.COMPONENT,
        description: "Restore hidden accounts",
        component: RestoreSection
    }
});

function notifyRestoreResult(r: Awaited<ReturnType<typeof restoreHiddenAccounts>>) {
    if (!r.added) return;

    Toasts.show({
        message: `MoreAccounts restored ${r.added} account${r.added === 1 ? "" : "s"}.`,
        id: Toasts.genId(),
        type: r.expired ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS
    });
}

function scheduleAutoRestore(delay = 1500) {
    if (!settings.store.autoRestore) return;

    if (autoRestoreTimer) clearTimeout(autoRestoreTimer);
    autoRestoreTimer = setTimeout(() => void runAutoRestore(), delay);
}

async function runAutoRestore() {
    if (autoRestoreRunning || !settings.store.autoRestore) return;
    autoRestoreRunning = true;

    try {
        await loadSavedAccounts();
        await saveCurrentAccounts();

        if (!storageReady()) {
            if (autoRestoreAttempts++ < 5) scheduleAutoRestore(2000);
            return;
        }

        autoRestoreAttempts = 0;
        notifyRestoreResult(await restoreHiddenAccounts(settings.store.maxAccounts));
    } catch {
        if (autoRestoreAttempts++ < 5) scheduleAutoRestore(2000);
    } finally {
        autoRestoreRunning = false;
    }
}

export default definePlugin({
    name: "MoreAccounts",
    description: "Removes the 5 account cap and restores saved accounts that Discord hides",
    authors: [Devs.trapstar],
    settings,

    get max() {
        const n = Math.floor(Number(settings.store.maxAccounts));
        return Number.isFinite(n) && n >= 5 ? n : 50;
    },

    flux: {
        CONNECTION_OPEN() {
            scheduleAutoRestore();
        },

        MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS() {
            void saveCurrentAccounts().catch(() => void 0);
        },

        CURRENT_USER_UPDATE() {
            void saveCurrentAccounts().catch(() => void 0);
        }
    },

    async start() {
        await loadSavedAccounts().catch(() => void 0);
        await saveCurrentAccounts().catch(() => void 0);
        scheduleAutoRestore();
    },

    stop() {
        if (autoRestoreTimer) clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        autoRestoreAttempts = 0;
        autoRestoreRunning = false;
    },

    patches: [
        {
            find: 'persistKey="MultiAccountStore"',
            replacement: {
                match: /(\(\i=\i\)\.length>)5(&&\i\.splice\()5(\))/,
                replace: "$1$self.max$2$self.max$3"
            }
        },
        {
            find: "maxNumAccounts:",
            replacement: {
                match: /(\.length>=)5(\?\i\(!0\))/,
                replace: "$1$self.max$2"
            }
        }
    ]
});
