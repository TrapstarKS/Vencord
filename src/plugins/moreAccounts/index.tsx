/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, Forms, React, RestAPI, TextArea, Toasts, UserStore, useState } from "@webpack/common";

import {
    addAccountsFromInput,
    getLastKnownProfile,
    getRestoreStats,
    getStoredTokenPublic,
    getVaultSourceAccounts,
    loadAvatarCache,
    loadSavedAccounts,
    peekPreservedToken,
    rehideTokenAfterSoftLogout,
    rememberAccountProfile,
    rememberTokenForSoftLogout,
    restoreHiddenAccounts,
    saveCurrentAccounts,
    storageReady
} from "./accounts";
import {
    getMissingVaultAccounts,
    getUnlockedVaultProfile,
    getVaultSnapshot,
    initializeVault,
    lockVault,
    saveAccountToUnlockedVault,
    syncVaultFromDiscord
} from "./vault";
import { VaultSection } from "./VaultSection";
import { openVaultUnlockModal, VaultUnlockReason } from "./VaultUnlockModal";

const logger = new Logger("MoreAccounts");
const Tokens = findByPropsLazy("getToken", "setToken", "encryptAndStoreTokens");
const AuthActions = findByPropsLazy("switchAccountToken", "logout");

let autoRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let autoRestoreAttempts = 0;
let autoRestoreRunning = false;
let autoVaultTimer: ReturnType<typeof setTimeout> | null = null;
let vaultPromptTimer: ReturnType<typeof setTimeout> | null = null;

let sessionPrimed = false;
let sessionStartupOffered = false;
let lastUserId: string | null = null;
let pendingSwitch = false;
let vaultModalOpen = false;
let dismissedStartup = false;
const dismissedSwitchForUser = new Set<string>();
const dismissedMissingIds = new Set<string>();

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

function AddTokenSection() {
    const [tokenInput, setTokenInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error?: boolean; } | null>(null);
    const [vaultHint, setVaultHint] = useState(() => getVaultSnapshot());

    React.useEffect(() => {
        let alive = true;
        void initializeVault().then(() => {
            if (alive) setVaultHint(getVaultSnapshot());
        }).catch(() => void 0);
        return () => void (alive = false);
    }, []);

    async function handleLogin() {
        setBusy(true);
        setMessage(null);

        try {
            const result = await addAccountsFromInput(tokenInput);
            if (!result.added && !result.skipped) {
                setMessage({
                    text: result.messages[0] ?? "Could not log in with that token.",
                    error: true
                });
                return;
            }

            setTokenInput("");
            await saveCurrentAccounts().catch(() => void 0);

            // Only newly switched accounts need vault save / unlock prompts.
            if (!result.added) {
                setMessage({ text: result.messages.join(" ") });
                return;
            }

            const snapshot = getVaultSnapshot();
            setVaultHint(snapshot);

            if (snapshot.exists && snapshot.unlocked) {
                const sync = await syncVaultFromDiscord();
                const vaultPart = sync.added || sync.updated
                    ? ` Vault: ${sync.added} new, ${sync.updated} updated.`
                    : " Already in the vault.";
                setMessage({
                    text: `${result.messages.join(" ")}${vaultPart}`
                });
                Toasts.show({
                    message: `Logged in and saved to vault (${result.added}).`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
                return;
            }

            if (snapshot.exists && !snapshot.unlocked) {
                setMessage({
                    text: `${result.messages.join(" ")} Vault is locked — enter the password to encrypt the new account(s).`
                });
                // Offer unlock immediately so the fresh login lands in the vault without hunting settings.
                if (!vaultModalOpen) {
                    vaultModalOpen = true;
                    const missing = getMissingVaultAccounts();
                    openVaultUnlockModal({
                        reason: "new-account",
                        missingAccounts: missing.length ? missing : undefined,
                        onDismiss() {
                            vaultModalOpen = false;
                        },
                        onUnlocked() {
                            vaultModalOpen = false;
                        }
                    });
                }
                return;
            }

            setMessage({
                text: `${result.messages.join(" ")} Create a vault below if you want an encrypted backup.`
            });
            Toasts.show({
                message: `Logged in ${result.added} account${result.added === 1 ? "" : "s"}.`,
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS
            });
        } catch {
            setMessage({ text: "Login failed, check the console.", error: true });
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="vc-moreAccounts-tokenLogin">
            <Forms.FormTitle>Log in with token</Forms.FormTitle>
            <Forms.FormText className="vc-moreAccounts-helpText">
                Paste a Discord token (or JSON with several tokens). Switches into the account and, if the vault is unlocked, saves it there automatically by user ID.
                {vaultHint.exists && !vaultHint.unlocked
                    ? " Vault is locked right now — unlock it first for encrypted save, or log in and unlock when prompted."
                    : vaultHint.exists && vaultHint.unlocked
                        ? " Vault is unlocked · new logins will be encrypted automatically."
                        : ""}
            </Forms.FormText>
            <TextArea
                value={tokenInput}
                onChange={setTokenInput}
                placeholder="Paste token here…"
                disabled={busy}
                rows={3}
            />
            <Flex className="vc-moreAccounts-actions">
                <Button onClick={() => void handleLogin()} disabled={busy || !tokenInput.trim()}>
                    {busy ? "Logging in…" : vaultHint.exists && vaultHint.unlocked ? "Log in & save to vault" : "Log in"}
                </Button>
            </Flex>
            {message && (
                <div className={`vc-moreAccounts-message ${message.error ? "vc-moreAccounts-messageError" : ""}`}>
                    {message.text}
                </div>
            )}
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
    promptVaultOnStartup: {
        type: OptionType.BOOLEAN,
        description: "Ask for the vault password when Discord starts (if the vault is locked)",
        default: true
    },
    promptVaultOnAccountSwitch: {
        type: OptionType.BOOLEAN,
        description: "Ask for the vault password after switching accounts in the multi-account switcher",
        default: true
    },
    promptVaultOnNewAccount: {
        type: OptionType.BOOLEAN,
        description: "Ask to unlock the vault when a logged-in account is not in the encrypted backup yet",
        default: true
    },
    softLogout: {
        type: OptionType.BOOLEAN,
        description: "Keep tokens when logging out / removing accounts by blocking Discord’s logout API (token stays valid on the server). Turn off to fully invalidate sessions on logout",
        default: true
    },
    checkTokenHealthOnUnlock: {
        type: OptionType.BOOLEAN,
        description: "When the vault unlocks, probe each saved token with Discord and show Token OK / Token dead badges on account cards",
        default: true
    },
    restore: {
        type: OptionType.COMPONENT,
        description: "Restore hidden accounts",
        component: RestoreSection
    },
    addByToken: {
        type: OptionType.COMPONENT,
        description: "Log in with a token and save to the vault",
        component: AddTokenSection
    },
    encryptedVault: {
        type: OptionType.COMPONENT,
        description: "Encrypted, portable account backup",
        component: VaultSection
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

function notifyVaultSyncResult(r: Awaited<ReturnType<typeof syncVaultFromDiscord>>) {
    if (!r.added) return;

    Toasts.show({
        message: `Saved ${r.added} new account${r.added === 1 ? "" : "s"} to the vault.`,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS
    });
}

function scheduleAutoRestore(delay = 1500) {
    if (!settings.store.autoRestore) return;

    if (autoRestoreTimer) clearTimeout(autoRestoreTimer);
    autoRestoreTimer = setTimeout(() => void runAutoRestore(), delay);
}

function scheduleVaultSync(delay = 1200) {
    if (autoVaultTimer) clearTimeout(autoVaultTimer);
    autoVaultTimer = setTimeout(() => {
        autoVaultTimer = null;
        void syncVaultFromDiscord()
            .then(notifyVaultSyncResult)
            .catch(() => void 0);
    }, delay);
}

function scheduleVaultPrompt(delay = 1200) {
    if (vaultPromptTimer) clearTimeout(vaultPromptTimer);
    vaultPromptTimer = setTimeout(() => {
        vaultPromptTimer = null;
        void runVaultPrompt().catch(() => void 0);
    }, delay);
}

function noteConnectionOpen() {
    const userId = (UserStore as any).getCurrentUser?.()?.id ?? null;

    if (!sessionPrimed) {
        sessionPrimed = true;
        pendingSwitch = false;
    } else if (userId && userId !== lastUserId) {
        pendingSwitch = true;
    }

    if (userId) lastUserId = userId;
    scheduleVaultPrompt();
}

async function runVaultPrompt() {
    if (vaultModalOpen) return;

    await initializeVault().catch(() => void 0);

    const snapshot = getVaultSnapshot();
    if (!snapshot.exists || snapshot.unlocked) {
        pendingSwitch = false;
        if (snapshot.unlocked) sessionStartupOffered = true;
        return;
    }

    const userId = (UserStore as any).getCurrentUser?.()?.id ?? lastUserId;
    const missing = settings.store.promptVaultOnNewAccount
        ? getMissingVaultAccounts().filter(account => !dismissedMissingIds.has(account.id))
        : [];

    const switchForUser = pendingSwitch ? userId : null;
    const isSwitch = !!switchForUser
        && settings.store.promptVaultOnAccountSwitch
        && !dismissedSwitchForUser.has(switchForUser);

    let reason: VaultUnlockReason | null = null;

    if (missing.length > 0) {
        reason = "new-account";
    } else if (isSwitch) {
        reason = "switch";
    } else if (
        !sessionStartupOffered
        && settings.store.promptVaultOnStartup
        && !dismissedStartup
    ) {
        reason = "startup";
    }

    // Consume one-shot switch detection after evaluating this tick.
    pendingSwitch = false;

    if (!sessionStartupOffered) {
        // Mark startup as handled once we have a user and either prompted or decided not to.
        if (reason != null || userId != null) sessionStartupOffered = true;
    }

    if (!reason) return;

    vaultModalOpen = true;

    openVaultUnlockModal({
        reason,
        // Show missing accounts whenever we know about them, even if the primary reason is startup/switch.
        missingAccounts: missing.length > 0 ? missing : undefined,
        onDismiss() {
            vaultModalOpen = false;
            if (reason === "startup") dismissedStartup = true;
            if (reason === "switch" && switchForUser) dismissedSwitchForUser.add(switchForUser);
            if (missing.length) {
                for (const account of missing) dismissedMissingIds.add(account.id);
            }
        },
        onUnlocked() {
            vaultModalOpen = false;
            dismissedStartup = true;
            sessionStartupOffered = true;
            if (switchForUser) dismissedSwitchForUser.delete(switchForUser);
            for (const account of missing) dismissedMissingIds.delete(account.id);
        }
    });
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

function resetSessionPromptState() {
    sessionPrimed = false;
    sessionStartupOffered = false;
    lastUserId = null;
    pendingSwitch = false;
    vaultModalOpen = false;
    dismissedStartup = false;
    dismissedSwitchForUser.clear();
    dismissedMissingIds.clear();
}

let softLogoutHooked = false;
const softLogoutToastAt = new Map<string, number>();
let originalFetch: typeof window.fetch | null = null;

function isSnowflakeId(value: unknown): value is string {
    return typeof value === "string" && /^\d{5,32}$/.test(value);
}

function isPlausibleToken(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 20
        && value.length <= 4096
        && !/\s/.test(value);
}

/** Only accept real Discord user ids — never i18n keys like "multi_accounts_list". */
function extractSnowflakeUserId(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        if (isSnowflakeId(candidate)) return candidate;
        if (candidate && typeof candidate === "object") {
            const obj = candidate as Record<string, unknown>;
            for (const key of ["userId", "id", "accountId"]) {
                if (isSnowflakeId(obj[key])) return obj[key] as string;
            }
        }
    }
    return null;
}

function isLogoutRequestUrl(url: unknown): boolean {
    if (typeof url !== "string") return false;
    // Discord revokes the session with POST /auth/logout (sometimes with query params).
    return /\/auth\/logout(?:\?|$)/i.test(url) || url.includes("/auth/logout");
}

function isLogoutHttpOpts(opts: any): boolean {
    if (!opts || typeof opts !== "object") return false;
    const url = opts.url ?? opts.path ?? opts.endpoint;
    return isLogoutRequestUrl(url);
}

function fakeLogoutResponse() {
    return Promise.resolve({
        ok: true,
        status: 204,
        statusCode: 204,
        headers: {},
        body: {},
        text: async () => "",
        json: async () => ({})
    });
}

function snapshotProfileBeforeLogout(userId: string) {
    // Capture switcher / UserStore while the row still exists.
    try {
        const sources = getVaultSourceAccounts();
        const fromSwitcher = sources.find(a => a.id === userId);
        if (fromSwitcher) rememberAccountProfile(fromSwitcher);
    } catch { }

    try {
        const me = (UserStore as any).getCurrentUser?.();
        if (me?.id === userId) rememberAccountProfile(me);
    } catch { }

    try {
        const user = (UserStore as any).getUser?.(userId);
        if (user) rememberAccountProfile(user);
    } catch { }
}

function buildSoftLogoutVaultAccount(userId: string, token: string) {
    const last = getLastKnownProfile(userId);
    const vaultPrev = getUnlockedVaultProfile(userId);
    const live = getVaultSourceAccounts().find(a => a.id === userId);

    const username = live?.username
        || (last && !last.username.startsWith("Account ") ? last.username : null)
        || vaultPrev?.username
        || last?.username
        || `Account ${userId}`;

    return {
        id: userId,
        username,
        avatar: live?.avatar ?? last?.avatar ?? vaultPrev?.avatar ?? null,
        discriminator: live?.discriminator ?? last?.discriminator ?? vaultPrev?.discriminator ?? "0",
        globalName: live?.globalName ?? last?.globalName ?? vaultPrev?.globalName ?? null,
        token
    };
}

function captureCurrentTokenForSoftLogout(explicitUserId?: string) {
    if (!settings.store.softLogout) return;

    try {
        const userId = extractSnowflakeUserId(
            explicitUserId,
            (UserStore as any).getCurrentUser?.()?.id
        );
        if (!userId) return;

        snapshotProfileBeforeLogout(userId);

        const rawToken = getStoredTokenPublic(userId)
            ?? (typeof (Tokens as any)?.getToken === "function" ? (Tokens as any).getToken(userId) : null)
            ?? (typeof (Tokens as any)?.getToken === "function" ? (Tokens as any).getToken() : null);

        if (isPlausibleToken(rawToken)) {
            rememberTokenForSoftLogout(userId, rawToken);
            void preserveAccountOnSoftLogout(userId, rawToken);
        }
    } catch (e) {
        logger.warn("soft-logout: failed to capture token", e);
    }
}

async function preserveAccountOnSoftLogout(userId: string, token: string | null) {
    if (!isSnowflakeId(userId)) {
        logger.warn("soft-logout: ignoring non-snowflake user id", userId);
        return;
    }

    snapshotProfileBeforeLogout(userId);

    const resolved = (isPlausibleToken(token) ? token : null) || peekPreservedToken(userId);
    if (!isPlausibleToken(resolved)) {
        logger.warn("soft-logout: no plausible token for", userId);
        return;
    }

    rememberTokenForSoftLogout(userId, resolved);

    // Prefer vault when unlocked so restore works after remove — keep last known avatar/nick.
    const snapshot = getVaultSnapshot();
    if (snapshot.exists && snapshot.unlocked) {
        try {
            const account = buildSoftLogoutVaultAccount(userId, resolved);
            const ok = await saveAccountToUnlockedVault(account);
            if (!ok) logger.warn("soft-logout: vault rejected account", userId);
        } catch (e) {
            logger.warn("soft logout: failed to write vault entry", e);
        }
    }

    // Re-hide token after Discord finishes removing the switcher row (silent on success).
    window.setTimeout(() => {
        if (!settings.store.softLogout) return;
        if (rehideTokenAfterSoftLogout(userId, resolved)) return;

        const now = Date.now();
        const last = softLogoutToastAt.get(userId) ?? 0;
        if (now - last < 2000) return;
        softLogoutToastAt.set(userId, now);

        Toasts.show({
            message: "Could not keep token after logout — check the vault.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }, 50);
}

function wrapHttpMethod(api: any, method: string) {
    if (!api || typeof api[method] !== "function" || api[method].__moreAccountsSoftLogout) return;

    const original = api[method].bind(api);
    const wrapped = function (this: unknown, opts: any, ...rest: unknown[]) {
        if (settings.store.softLogout && isLogoutHttpOpts(opts)) {
            logger.info(`soft-logout: blocked RestAPI.${method} logout`);
            captureCurrentTokenForSoftLogout();
            return fakeLogoutResponse();
        }
        return original(opts, ...rest);
    };
    wrapped.__moreAccountsSoftLogout = true;
    api[method] = wrapped;
}

function installSoftLogoutHooks() {
    if (softLogoutHooked) return;
    softLogoutHooked = true;

    // 1) Block server-side session revoke — this is what actually "expires" the token.
    try {
        wrapHttpMethod(RestAPI, "post");
        wrapHttpMethod(RestAPI, "del");
        wrapHttpMethod(RestAPI, "delete");
        logger.info("soft-logout: hooked RestAPI logout paths");
    } catch (e) {
        logger.warn("soft-logout: RestAPI hook failed", e);
    }

    try {
        if (!originalFetch) {
            originalFetch = window.fetch.bind(window);
            window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
                const url = typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.href
                        : (input as Request)?.url;

                if (settings.store.softLogout && isLogoutRequestUrl(url)) {
                    logger.info("soft-logout: blocked fetch logout");
                    captureCurrentTokenForSoftLogout();
                    return Promise.resolve(new Response(null, { status: 204, statusText: "No Content" }));
                }
                return originalFetch!(input, init);
            };
        }
    } catch (e) {
        logger.warn("soft-logout: fetch hook failed", e);
    }

    // 2) Capture token as early as AuthActions.logout runs (before storage wipe).
    try {
        const auth = AuthActions as any;
        if (auth && typeof auth.logout === "function" && !auth.__moreAccountsSoftLogoutLogout) {
            const originalLogout = auth.logout.bind(auth);
            auth.logout = function (...args: unknown[]) {
                if (settings.store.softLogout) {
                    // logout() args are often booleans/options — never treat random strings as user ids.
                    captureCurrentTokenForSoftLogout(extractSnowflakeUserId(...args) ?? undefined);
                }
                return originalLogout(...args);
            };
            auth.__moreAccountsSoftLogoutLogout = true;
            logger.info("soft-logout: hooked AuthActions.logout");
        }
    } catch (e) {
        logger.warn("soft-logout: AuthActions.logout hook failed", e);
    }

    // 3) Preserve when multi-account token map is cleared.
    try {
        const tokens = Tokens as any;
        if (tokens && typeof tokens.removeToken === "function" && !tokens.__moreAccountsSoftLogout) {
            const original = tokens.removeToken.bind(tokens);
            tokens.removeToken = function (userId: string, ...rest: unknown[]) {
                const id = extractSnowflakeUserId(userId);
                if (settings.store.softLogout && id) {
                    const token = getStoredTokenPublic(id);
                    if (isPlausibleToken(token)) void preserveAccountOnSoftLogout(id, token);
                }
                return original(userId, ...rest);
            };
            tokens.__moreAccountsSoftLogout = true;
            logger.info("soft-logout: hooked Tokens.removeToken");
        }
    } catch (e) {
        logger.warn("soft-logout: removeToken hook failed", e);
    }
}

function handleMultiAccountRemove(event: any) {
    if (!settings.store.softLogout) return;

    // Flux payloads vary; only accept a real snowflake (never i18n keys like multi_accounts_list).
    const userId = extractSnowflakeUserId(event, event?.userId, event?.id, event?.accountId);
    if (!userId) {
        logger.warn("soft-logout: MULTI_ACCOUNT_REMOVE_ACCOUNT without snowflake id", event);
        return;
    }

    const token = getStoredTokenPublic(userId) ?? peekPreservedToken(userId);
    void preserveAccountOnSoftLogout(userId, token);
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
            scheduleVaultSync();
            noteConnectionOpen();
            installSoftLogoutHooks();
        },

        MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS() {
            void saveCurrentAccounts().catch(() => void 0);
            scheduleVaultSync();
            scheduleVaultPrompt();
        },

        CURRENT_USER_UPDATE() {
            void saveCurrentAccounts().catch(() => void 0);
            scheduleVaultSync();
            scheduleVaultPrompt();
        },

        MULTI_ACCOUNT_REMOVE_ACCOUNT(event: any) {
            handleMultiAccountRemove(event);
        },

        LOGOUT() {
            // Capture before stores fully clear when soft logout is on.
            if (settings.store.softLogout) captureCurrentTokenForSoftLogout();
        }
    },

    async start() {
        await initializeVault().catch(() => void 0);
        await loadSavedAccounts().catch(() => void 0);
        await loadAvatarCache().catch(() => void 0);
        await saveCurrentAccounts().catch(() => void 0);
        installSoftLogoutHooks();
        scheduleAutoRestore();
        scheduleVaultSync();

        const userId = (UserStore as any).getCurrentUser?.()?.id ?? null;
        if (userId) lastUserId = userId;
        scheduleVaultPrompt(1800);
    },

    stop() {
        if (autoRestoreTimer) clearTimeout(autoRestoreTimer);
        autoRestoreTimer = null;
        autoRestoreAttempts = 0;
        autoRestoreRunning = false;
        if (autoVaultTimer) clearTimeout(autoVaultTimer);
        autoVaultTimer = null;
        if (vaultPromptTimer) clearTimeout(vaultPromptTimer);
        vaultPromptTimer = null;
        resetSessionPromptState();
        // Restore fetch if we wrapped it (best-effort; RestAPI wraps stay until reload).
        if (originalFetch) {
            try {
                window.fetch = originalFetch;
            } catch { }
            originalFetch = null;
        }
        softLogoutHooked = false;
        lockVault();
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
