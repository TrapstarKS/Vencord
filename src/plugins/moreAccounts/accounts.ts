/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { find, findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI, UserStore } from "@webpack/common";

const logger = new Logger("MoreAccounts");

const DATA_KEY = "MoreAccounts_savedAccounts";
const AVATAR_CACHE_KEY = "MoreAccounts_avatarCache_v1";
const DEFAULT_MAX_ACCOUNTS = 50;
const MIN_ACCOUNTS = 5;
const TOKEN_STATUS_INVALID = 0;
const TOKEN_STATUS_VALID = 2;
/** Cap cached avatars so DataStore stays small (~100KB each max, 40 entries). */
const MAX_AVATAR_CACHE_ENTRIES = 40;
const MAX_AVATAR_DATA_URL_CHARS = 140_000;

const Tokens = findByPropsLazy("getToken", "setToken", "encryptAndStoreTokens");
const MultiAccountStore = findStoreLazy("MultiAccountStore");
const AuthActions = findByPropsLazy("switchAccountToken", "logout");

interface KvStorage {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    remove(key: string): void;
}

interface SavedAccount {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
    tokenStatus: number;
    lastSeen: number;
}

export interface RestoreStats {
    inSwitcher: number;
    saved: number;
    hidden: number;
    withoutToken: number;
    capacity: number;
    storageReady: boolean;
}

export interface RestoreResult {
    added: number;
    valid: number;
    expired: number;
    unknown: number;
    skippedNoToken: number;
    skippedLimit: number;
    skippedMismatch: number;
}

export interface KnownAccountToken {
    id: string;
    username: string;
    token: string;
}

export interface VaultSourceAccount extends KnownAccountToken {
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
}

/** Profile fields without token — last known state for soft-logout / vault cards. */
export interface AccountProfile {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
}

export interface AddTokenResult {
    ok: boolean;
    reason?: "empty" | "invalid" | "expired" | "timeout" | "already" | "mismatch" | "store_failed";
    username?: string;
    /** True when the account was already in the switcher / current session (no switch performed). */
    alreadyPresent?: boolean;
    /** True when the account was listed as "Sign in again" and the vault token re-activated it. */
    repaired?: boolean;
}

export interface AddAccountOptions {
    /**
     * `switch` — full session switch via switchAccountToken (login-by-token UI).
     * `switcher` — inject token + MultiAccountStore entry without leaving the current session (vault restore).
     */
    mode?: "switch" | "switcher";
    /** When restoring a vault entry, ensure the token still belongs to this user id. */
    expectedId?: string;
}

export interface AddTokensResult {
    total: number;
    added: number;
    skipped: number;
    failed: number;
    messages: string[];
}

type SavedAccounts = Record<string, SavedAccount>;

type TokenCheck =
    | { state: "valid"; user: any; }
    | { state: "expired"; }
    | { state: "mismatch"; user: any; }
    | { state: "unknown"; error?: unknown; };

let cache: KvStorage | null = null;
let savedAccounts: SavedAccounts = {};
let savedAccountsReady = false;
let savePromise: Promise<void> | null = null;

/** In-memory last-seen profiles (switcher / UserStore) for soft-logout after the row is gone. */
const profileCache = new Map<string, AccountProfile>();

/** Local avatar data-URLs so vault cards keep a face after soft-logout / CDN churn. */
const avatarCache = new Map<string, string>();
const avatarFetchInFlight = new Set<string>();
let avatarCacheReady = false;
let avatarCachePersist: Promise<void> | null = null;

export type AccountSessionStatus = "current" | "active" | "needs_login" | "ready";

/** Result of probing a stored token against Discord (/users/@me). */
export type TokenHealthStatus = "valid" | "invalid" | "mismatch" | "unknown" | "checking" | "unchecked";

export interface TokenHealthEntry {
    status: TokenHealthStatus;
    checkedAt: number | null;
}

const tokenHealthCache = new Map<string, TokenHealthEntry>();
const tokenHealthListeners = new Set<() => void>();

function emitTokenHealth() {
    for (const l of tokenHealthListeners) l();
}

export function subscribeTokenHealth(listener: () => void) {
    tokenHealthListeners.add(listener);
    return () => {
        tokenHealthListeners.delete(listener);
    };
}

export function getTokenHealth(userId: string): TokenHealthEntry {
    if (!isSnowflake(userId)) return { status: "unchecked", checkedAt: null };
    return tokenHealthCache.get(userId) ?? { status: "unchecked", checkedAt: null };
}

function setTokenHealth(userId: string, status: TokenHealthStatus) {
    if (!isSnowflake(userId)) return;
    const prev = tokenHealthCache.get(userId);
    tokenHealthCache.set(userId, {
        status,
        checkedAt: status === "checking" || status === "unchecked"
            ? prev?.checkedAt ?? null
            : Date.now()
    });
    emitTokenHealth();
}

/**
 * Probe a token with GET /users/@me (fetch-first, no session Authorization override).
 * Updates the in-memory health badge cache for this user id.
 */
export async function validateTokenForUser(userId: string, token: string): Promise<TokenHealthStatus> {
    if (!isSnowflake(userId) || typeof token !== "string" || token.length < 20) {
        setTokenHealth(userId, "invalid");
        return "invalid";
    }

    setTokenHealth(userId, "checking");
    const result = await checkToken(userId, token);

    let health: TokenHealthStatus;
    switch (result.state) {
        case "valid":
            health = "valid";
            // Refresh profile cache when we get a live user payload.
            if (result.user) rememberAccountProfile(result.user);
            break;
        case "expired":
            health = "invalid";
            break;
        case "mismatch":
            health = "mismatch";
            break;
        default:
            health = "unknown";
    }

    tokenHealthCache.set(userId, { status: health, checkedAt: Date.now() });
    emitTokenHealth();
    return health;
}

/** Current session is live — treat as valid without an extra request. */
export function markCurrentSessionTokenHealthy(userId: string) {
    if (!isSnowflake(userId)) return;
    tokenHealthCache.set(userId, { status: "valid", checkedAt: Date.now() });
    emitTokenHealth();
}

function isSnowflake(id: unknown): id is string {
    return typeof id === "string" && /^\d+$/.test(id);
}

function normalizeMax(maxAccounts: number) {
    const n = Math.floor(Number(maxAccounts));
    return Number.isFinite(n) && n >= MIN_ACCOUNTS ? n : DEFAULT_MAX_ACCOUNTS;
}

function isKv(o: any): o is KvStorage {
    return o != null && typeof o.get === "function" && typeof o.set === "function" && typeof o.remove === "function";
}

function hasTokens(o: KvStorage) {
    try {
        const t = o.get("tokens");
        return t != null && typeof t === "object" && Object.keys(t).some(isSnowflake);
    } catch {
        return false;
    }
}

function storage() {
    if (isKv(cache)) return cache;

    const mod = find((m: any) => {
        if (!m || typeof m !== "object") return false;

        try {
            return Object.values(m).some((v: any) => isKv(v) && hasTokens(v));
        } catch {
            return false;
        }
    }, { isIndirect: true }) as Record<string, unknown> | null;

    cache = mod ? Object.values(mod).find((v): v is KvStorage => isKv(v) && hasTokens(v)) ?? null : null;
    return cache;
}

function getSwitcherUsers(): any[] {
    const users = (MultiAccountStore as any)?.getUsers?.();
    return Array.isArray(users) ? users : [];
}

function storedIds(): string[] {
    try {
        return Object.keys(storage()?.get?.("tokens") ?? {}).filter(isSnowflake);
    } catch {
        return [];
    }
}

function getStoredToken(id: string): string | null {
    try {
        const token = (Tokens as any)?.getToken?.(id);
        return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
        return null;
    }
}

function normalizeSavedAccount(account: any): SavedAccount | null {
    if (!isSnowflake(account?.id)) return null;

    return {
        id: account.id,
        username: typeof account.username === "string" && account.username ? account.username : `Account ${account.id}`,
        avatar: typeof account.avatar === "string" ? account.avatar : null,
        discriminator: typeof account.discriminator === "string" ? account.discriminator : "0",
        globalName: typeof account.globalName === "string"
            ? account.globalName
            : typeof account.global_name === "string"
                ? account.global_name
                : null,
        tokenStatus: typeof account.tokenStatus === "number" ? account.tokenStatus : TOKEN_STATUS_VALID,
        lastSeen: typeof account.lastSeen === "number" ? account.lastSeen : Date.now()
    };
}

function saveableAccount(account: any): SavedAccount | null {
    const normalized = normalizeSavedAccount(account);
    if (!normalized) return null;

    return {
        ...normalized,
        tokenStatus: typeof account.tokenStatus === "number" ? account.tokenStatus : TOKEN_STATUS_VALID,
        lastSeen: Date.now()
    };
}

function profileFromAny(account: any): AccountProfile | null {
    if (!isSnowflake(account?.id)) return null;

    const username = typeof account.username === "string" && account.username
        ? account.username
        : null;
    const globalName = typeof account.globalName === "string"
        ? account.globalName
        : typeof account.global_name === "string"
            ? account.global_name
            : null;

    // Skip empty placeholders like "Account 123" only if we have nothing better later.
    return {
        id: account.id,
        username: username ?? `Account ${account.id}`,
        avatar: typeof account.avatar === "string" ? account.avatar : null,
        discriminator: typeof account.discriminator === "string" ? account.discriminator : "0",
        globalName
    };
}

function isPlaceholderUsername(username: string, id: string) {
    return username === `Account ${id}` || username.startsWith("Account multi_");
}

function mergeProfiles(base: AccountProfile | null, incoming: AccountProfile | null): AccountProfile | null {
    if (!base) return incoming;
    if (!incoming) return base;

    const incomingIsPlaceholder = isPlaceholderUsername(incoming.username, incoming.id);
    const baseIsPlaceholder = isPlaceholderUsername(base.username, base.id);

    return {
        id: base.id,
        username: !incomingIsPlaceholder
            ? incoming.username
            : !baseIsPlaceholder
                ? base.username
                : incoming.username,
        avatar: incoming.avatar ?? base.avatar,
        discriminator: incoming.discriminator && incoming.discriminator !== "0"
            ? incoming.discriminator
            : base.discriminator,
        globalName: incoming.globalName ?? base.globalName
    };
}

/** Remember avatar / nick / username for later soft-logout (in-memory + savedAccounts). */
export function rememberAccountProfile(account: any) {
    const profile = profileFromAny(account);
    if (!profile) return;

    const previous = profileCache.get(profile.id) ?? null;
    const merged = mergeProfiles(previous, profile);
    if (!merged) return;

    profileCache.set(profile.id, merged);

    const saved = saveableAccount({ ...merged, tokenStatus: TOKEN_STATUS_VALID });
    if (saved) {
        savedAccounts[saved.id] = {
            ...savedAccounts[saved.id],
            ...saved,
            lastSeen: Date.now()
        };
    }
}

export async function loadAvatarCache() {
    if (avatarCacheReady) return;
    try {
        const stored = await DataStore.get<Record<string, string>>(AVATAR_CACHE_KEY);
        if (stored && typeof stored === "object") {
            for (const [id, dataUrl] of Object.entries(stored)) {
                if (isSnowflake(id) && typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
                    avatarCache.set(id, dataUrl);
                }
            }
        }
    } catch (e) {
        logger.warn("loadAvatarCache failed", e);
    }
    avatarCacheReady = true;
}

function persistAvatarCache() {
    if (avatarCachePersist) return avatarCachePersist;

    avatarCachePersist = (async () => {
        // Drop oldest excess by re-building from Map insertion order.
        while (avatarCache.size > MAX_AVATAR_CACHE_ENTRIES) {
            const first = avatarCache.keys().next().value;
            if (first == null) break;
            avatarCache.delete(first);
        }
        const obj: Record<string, string> = {};
        for (const [id, dataUrl] of avatarCache) obj[id] = dataUrl;
        await DataStore.set(AVATAR_CACHE_KEY, obj);
    })().finally(() => {
        avatarCachePersist = null;
    });

    return avatarCachePersist;
}

export function getCachedAvatarDataUrl(userId: string): string | null {
    if (!isSnowflake(userId)) return null;
    return avatarCache.get(userId) ?? null;
}

/** Best-effort: download a CDN avatar and store as a data URL for offline vault cards. */
export async function rememberAvatarFromCdn(userId: string, url: string) {
    if (!isSnowflake(userId) || !url || avatarCache.has(userId) || avatarFetchInFlight.has(userId)) return;
    if (!url.includes("cdn.discordapp.com") && !url.includes("media.discordapp.net")) return;

    avatarFetchInFlight.add(userId);
    try {
        await loadAvatarCache();
        if (avatarCache.has(userId)) return;

        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size > 120_000) return;

        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
            reader.readAsDataURL(blob);
        });

        if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_AVATAR_DATA_URL_CHARS) return;

        // Refresh insertion order for LRU-ish eviction.
        avatarCache.delete(userId);
        avatarCache.set(userId, dataUrl);
        await persistAvatarCache();
    } catch (e) {
        logger.debug("rememberAvatarFromCdn failed", userId, e);
    } finally {
        avatarFetchInFlight.delete(userId);
    }
}

/**
 * How this account relates to the live multi-account switcher.
 * - current: active Discord session
 * - active: usable in switcher
 * - needs_login: listed as “Sign in again” (or broken token row)
 * - ready: not in switcher; vault can restore
 */
export function getAccountSessionStatus(userId: string): AccountSessionStatus {
    if (!isSnowflake(userId)) return "ready";

    try {
        if ((UserStore as any).getCurrentUser?.()?.id === userId) return "current";
    } catch { }

    if (isAccountActivelyUsable(userId)) return "active";
    if (isAccountListed(userId)) return "needs_login";
    return "ready";
}

/**
 * Last known display profile for a user (switcher cache → savedAccounts → UserStore).
 * Used when soft-logout runs after Discord already removed the multi-account row.
 */
export function getLastKnownProfile(userId: string): AccountProfile | null {
    if (!isSnowflake(userId)) return null;

    let result: AccountProfile | null = profileCache.get(userId) ?? null;

    const fromSwitcher = getSwitcherUsers().find(u => u?.id === userId);
    if (fromSwitcher) {
        result = mergeProfiles(result, profileFromAny(fromSwitcher));
        rememberAccountProfile(fromSwitcher);
    }

    const saved = savedAccounts[userId];
    if (saved) {
        result = mergeProfiles(result, {
            id: saved.id,
            username: saved.username,
            avatar: saved.avatar,
            discriminator: saved.discriminator,
            globalName: saved.globalName
        });
    }

    try {
        const user = (UserStore as any).getUser?.(userId) ?? (UserStore as any).getCurrentUser?.();
        if (user?.id === userId) {
            result = mergeProfiles(result, profileFromAny(user));
        }
    } catch { }

    return result;
}

function toMultiAccountUser(id: string, profile: any, tokenStatus: number) {
    const saved = normalizeSavedAccount({ ...(profile ?? {}), id });

    return {
        id,
        username: profile?.username ?? saved?.username ?? `Account ${id}`,
        avatar: profile?.avatar ?? saved?.avatar ?? null,
        discriminator: profile?.discriminator ?? saved?.discriminator ?? "0",
        globalName: profile?.globalName ?? profile?.global_name ?? saved?.globalName ?? null,
        tokenStatus,
        pushSyncToken: null
    };
}

function getErrorStatus(error: any): number | undefined {
    return error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.body?.status;
}

function isAuthFailureStatus(status: number | undefined) {
    return status === 401 || status === 403;
}

async function checkWithRest(id: string, token: string): Promise<TokenCheck> {
    try {
        const res: any = await (RestAPI as any).get({
            url: "/users/@me",
            headers: { authorization: token }
        });

        const user = res?.body;
        if (user?.id === id) return { state: "valid", user };
        if (isSnowflake(user?.id)) return { state: "mismatch", user };

        return { state: "unknown" };
    } catch (e) {
        if (isAuthFailureStatus(getErrorStatus(e))) return { state: "expired" };
        return { state: "unknown", error: e };
    }
}

async function checkWithFetch(id: string, token: string): Promise<TokenCheck> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
        const res = await fetch(`${location.origin}/api/v9/users/@me`, {
            headers: { authorization: token },
            credentials: "omit",
            signal: controller.signal
        });

        if (isAuthFailureStatus(res.status)) return { state: "expired" };
        if (!res.ok) return { state: "unknown" };

        const user = await res.json().catch(() => null);
        if (user?.id === id) return { state: "valid", user };
        if (isSnowflake(user?.id)) return { state: "mismatch", user };

        return { state: "unknown" };
    } catch (e) {
        return { state: "unknown", error: e };
    } finally {
        clearTimeout(timeout);
    }
}

async function checkToken(id: string, token: string): Promise<TokenCheck> {
    // Prefer raw fetch: Discord's RestAPI often attaches the *current* session Authorization
    // and ignores our header, which falsely reports mismatch for every other account token.
    const fetched = await checkWithFetch(id, token);
    if (fetched.state === "valid" || fetched.state === "expired" || fetched.state === "mismatch") {
        return fetched;
    }

    const rest = await checkWithRest(id, token);
    if (rest.state === "valid" || rest.state === "expired") return rest;

    // A RestAPI "mismatch" after fetch failed is usually the session user, not the token under test.
    if (rest.state === "mismatch") {
        logger.warn(`RestAPI returned a different user while checking ${id}; ignoring (likely session auth override)`);
        return { state: "unknown" };
    }

    return fetched.state !== "unknown" ? fetched : rest;
}

function normalizeToken(raw: string): string {
    let token = raw.trim().replace(/^\uFEFF/, "");
    if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
    if (
        (token.startsWith("\"") && token.endsWith("\""))
        || (token.startsWith("'") && token.endsWith("'"))
    ) {
        token = token.slice(1, -1).trim();
    }
    return token;
}

/**
 * Prefer raw fetch with credentials omitted so Discord's RestAPI session Authorization
 * cannot override the token under test (that would mis-identify every token as the current user).
 */
async function identifyToken(token: string): Promise<TokenCheck> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
        const res = await fetch(`${location.origin}/api/v9/users/@me`, {
            headers: { authorization: token },
            credentials: "omit",
            signal: controller.signal
        });

        if (isAuthFailureStatus(res.status)) return { state: "expired" };
        if (res.ok) {
            const user = await res.json().catch(() => null);
            if (isSnowflake(user?.id)) return { state: "valid", user };
            return { state: "unknown" };
        }
    } catch (e) {
        // fall through to RestAPI
        if ((e as any)?.name === "AbortError") return { state: "unknown", error: e };
    } finally {
        clearTimeout(timeout);
    }

    try {
        const res: any = await (RestAPI as any).get({
            url: "/users/@me",
            headers: { authorization: token },
            // Some builds accept this; harmless if ignored.
            rejectWithError: true
        });

        const user = res?.body;
        if (isSnowflake(user?.id)) return { state: "valid", user };
        return { state: "unknown" };
    } catch (e) {
        if (isAuthFailureStatus(getErrorStatus(e))) return { state: "expired" };
        return { state: "unknown", error: e };
    }
}

function storeTokenForUser(userId: string, token: string): boolean {
    let stored = false;

    try {
        if (Tokens && typeof (Tokens as any).setToken === "function") {
            const arity = (Tokens as any).setToken.length;
            // Multi-account TokenManager: setToken(userId, token). Some builds only expose setToken(token).
            if (arity >= 2) {
                (Tokens as any).setToken(userId, token);
            } else {
                try {
                    (Tokens as any).setToken(userId, token);
                } catch {
                    (Tokens as any).setToken(token);
                }
            }
            if (typeof (Tokens as any).encryptAndStoreTokens === "function") {
                (Tokens as any).encryptAndStoreTokens();
            }
            if (getStoredToken(userId)) stored = true;
        }
    } catch (e) {
        logger.warn(`Tokens.setToken failed for ${userId}`, e);
    }

    try {
        const s = storage();
        if (s) {
            const existing = s.get("tokens");
            const tokens = existing && typeof existing === "object" && !Array.isArray(existing)
                ? { ...(existing as Record<string, unknown>) }
                : {};
            tokens[userId] = token;
            s.set("tokens", tokens);

            if (Tokens && typeof (Tokens as any).encryptAndStoreTokens === "function") {
                try {
                    (Tokens as any).encryptAndStoreTokens();
                } catch { }
            }
            stored = true;
        }
    } catch (e) {
        logger.error(`failed to persist token for ${userId}`, e);
    }

    return stored || getStoredToken(userId) != null;
}

export interface SwitcherAccountProfile {
    id: string;
    token: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
}

/**
 * Add a vault (or other) account to the multi-account switcher without switching the active session.
 * Mirrors restoreHiddenAccounts: store token, push user row, soft-validate.
 * Only fails hard on empty / expired / token-user mismatch.
 */
export async function restoreAccountToSwitcher(account: SwitcherAccountProfile): Promise<AddTokenResult> {
    const token = normalizeToken(account.token);
    if (!token) return { ok: false, reason: "empty" };
    if (!isSnowflake(account.id)) return { ok: false, reason: "invalid" };

    const label = account.globalName || account.username || `Account ${account.id}`;
    const wasListedBroken = isAccountListed(account.id) && !isAccountActivelyUsable(account.id);

    // Fully usable session — do not switchAccountToken / re-inject.
    if (isAccountActivelyUsable(account.id)) {
        storeTokenForUser(account.id, token);
        return { ok: true, alreadyPresent: true, reason: "already", username: label };
    }

    storeTokenForUser(account.id, token);

    const users = getSwitcherUsers();
    if (!Array.isArray(users)) {
        logger.warn("MultiAccountStore unavailable; falling back to session switch");
        return addAccountByToken(token, { mode: "switch", expectedId: account.id });
    }

    FluxDispatcher.dispatch({
        type: "MULTI_ACCOUNT_VALIDATE_TOKEN_REQUEST",
        userId: account.id
    });

    const check = await checkToken(account.id, token);
    if (check.state === "mismatch") {
        return { ok: false, reason: "mismatch", username: label };
    }
    if (check.state === "expired") {
        return { ok: false, reason: "expired", username: label };
    }

    // valid OR unknown — same as restoreHiddenAccounts (unknown still re-adds with cached profile).
    const profile = check.state === "valid"
        ? check.user
        : {
            id: account.id,
            username: account.username,
            avatar: account.avatar,
            discriminator: account.discriminator,
            globalName: account.globalName
        };

    // Repair "Sign in again" rows in place; otherwise append.
    updateSwitcherUser(account.id, profile, TOKEN_STATUS_VALID);

    if (check.state === "valid") {
        FluxDispatcher.dispatch({ type: "USER_UPDATE", user: check.user });
    }

    FluxDispatcher.dispatch({
        type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",
        userId: account.id
    });

    await loadSavedAccounts();
    const saved = saveableAccount(toMultiAccountUser(account.id, profile, TOKEN_STATUS_VALID));
    if (saved) {
        savedAccounts[account.id] = saved;
        await persistSavedAccounts();
    }

    // If the token never landed in Discord storage, last resort: full session switch.
    if (!getStoredToken(account.id)) {
        logger.warn(`token for ${account.id} not readable after inject; falling back to switchAccountToken`);
        return addAccountByToken(token, { mode: "switch", expectedId: account.id });
    }

    return {
        ok: true,
        username: label,
        repaired: wasListedBroken || undefined
    };
}

/** Snapshot a token before Discord drops it (soft logout). */
const preservedTokens = new Map<string, string>();

export function rememberTokenForSoftLogout(userId: string, token?: string | null) {
    if (!isSnowflake(userId) || userId.length > 32) return;
    const value = typeof token === "string" && token.length >= 20 && token.length <= 4096
        ? token
        : getStoredToken(userId);
    if (value && value.length >= 20) preservedTokens.set(userId, value);
}

export function takePreservedToken(userId: string): string | null {
    const value = preservedTokens.get(userId) ?? null;
    if (value) preservedTokens.delete(userId);
    return value;
}

export function peekPreservedToken(userId: string): string | null {
    return preservedTokens.get(userId) ?? getStoredToken(userId);
}

/**
 * After Discord removes an account from the switcher, put the token back into local storage
 * so vault restore / hidden restore can still use it. Does not re-add the switcher row.
 */
export function rehideTokenAfterSoftLogout(userId: string, token?: string | null): boolean {
    if (!isSnowflake(userId)) return false;
    const value = (typeof token === "string" && token ? token : null)
        ?? takePreservedToken(userId)
        ?? getStoredToken(userId);
    if (!value) return false;
    return storeTokenForUser(userId, value);
}

export function getStoredTokenPublic(userId: string) {
    return getStoredToken(userId);
}

async function persistSavedAccounts() {
    await DataStore.set(DATA_KEY, savedAccounts);
}

export function storageReady() {
    return isKv(storage());
}

export async function loadSavedAccounts() {
    if (savedAccountsReady) return;

    const saved = await DataStore.get<SavedAccounts>(DATA_KEY);
    savedAccounts = {};

    if (saved && typeof saved === "object") {
        for (const account of Object.values(saved)) {
            const normalized = normalizeSavedAccount(account);
            if (normalized) {
                savedAccounts[normalized.id] = normalized;
                profileCache.set(normalized.id, {
                    id: normalized.id,
                    username: normalized.username,
                    avatar: normalized.avatar,
                    discriminator: normalized.discriminator,
                    globalName: normalized.globalName
                });
            }
        }
    }

    savedAccountsReady = true;
}

export function saveCurrentAccounts() {
    savePromise ??= (async () => {
        await loadSavedAccounts();

        let changed = false;
        for (const user of getSwitcherUsers()) {
            const account = saveableAccount(user);
            if (!account) continue;

            savedAccounts[account.id] = account;
            rememberAccountProfile(user);
            changed = true;
        }

        // Also cache the active user (always has full profile).
        try {
            const me = (UserStore as any).getCurrentUser?.();
            if (me) rememberAccountProfile(me);
        } catch { }

        if (changed) await persistSavedAccounts();
    })().finally(() => {
        savePromise = null;
    });

    return savePromise;
}

export function getRestoreStats(maxAccounts = DEFAULT_MAX_ACCOUNTS): RestoreStats {
    const users = getSwitcherUsers();
    const present = new Set(users.map(u => u?.id).filter(isSnowflake));
    const tokenIds = storedIds();
    const hidden = tokenIds.filter(id => !present.has(id));
    const savedHidden = Object.keys(savedAccounts).filter(id => !present.has(id));

    return {
        inSwitcher: present.size,
        saved: Object.keys(savedAccounts).length,
        hidden: hidden.length,
        withoutToken: savedHidden.filter(id => !tokenIds.includes(id)).length,
        capacity: Math.max(0, normalizeMax(maxAccounts) - users.length),
        storageReady: storageReady()
    };
}

export function countHidden() {
    return getRestoreStats().hidden;
}

export async function restoreHiddenAccounts(maxAccounts: number): Promise<RestoreResult> {
    const r: RestoreResult = {
        added: 0,
        valid: 0,
        expired: 0,
        unknown: 0,
        skippedNoToken: 0,
        skippedLimit: 0,
        skippedMismatch: 0
    };

    await loadSavedAccounts();
    await saveCurrentAccounts();

    const users = getSwitcherUsers();
    if (!users.length || !storage() || !Tokens) return r;

    const max = normalizeMax(maxAccounts);
    const present = new Set(users.map(u => u?.id).filter(isSnowflake));
    const hidden = storedIds().filter(id => !present.has(id));
    const toRestore = hidden.slice(0, Math.max(0, max - users.length));

    r.skippedLimit = hidden.length - toRestore.length;

    for (const id of toRestore) {
        try {
            if (present.has(id)) continue;

            const token = getStoredToken(id);
            if (!token) {
                r.skippedNoToken++;
                continue;
            }

            FluxDispatcher.dispatch({
                type: "MULTI_ACCOUNT_VALIDATE_TOKEN_REQUEST",
                userId: id
            });

            const check = await checkToken(id, token);
            if (check.state === "mismatch") {
                logger.warn(`stored token for ${id} belongs to ${check.user.id}; skipping restore`);
                r.skippedMismatch++;
                continue;
            }

            const cached = savedAccounts[id] ?? normalizeSavedAccount((UserStore as any).getUser?.(id));
            const profile = check.state === "valid" ? check.user : cached;
            const tokenStatus = check.state === "expired" ? TOKEN_STATUS_INVALID : TOKEN_STATUS_VALID;

            users.push(toMultiAccountUser(id, profile, tokenStatus));
            present.add(id);

            if (check.state === "valid") {
                const saved = saveableAccount(toMultiAccountUser(id, check.user, TOKEN_STATUS_VALID));
                if (saved) savedAccounts[id] = saved;

                FluxDispatcher.dispatch({
                    type: "USER_UPDATE",
                    user: check.user
                });
            }

            FluxDispatcher.dispatch({
                type: check.state === "expired" ? "MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE" : "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",
                userId: id
            });

            r.added++;
            if (check.state === "valid") r.valid++;
            else if (check.state === "expired") r.expired++;
            else r.unknown++;
        } catch (e) {
            logger.error(`failed to restore ${id}`, e);
            r.skippedNoToken++;
        }
    }

    await persistSavedAccounts();

    try {
        (MultiAccountStore as any)?.emitChange?.();
    } catch { }

    return r;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForActiveUser(id: string, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if ((UserStore as any).getCurrentUser?.()?.id === id) return true;
        await sleep(200);
    }

    return false;
}

/** True if the user id is the current session or appears anywhere in the multi-account list (even "Sign in again"). */
export function isAccountListed(userId: string): boolean {
    if (!isSnowflake(userId)) return false;

    try {
        if ((UserStore as any).getCurrentUser?.()?.id === userId) return true;
    } catch { }

    return getSwitcherUsers().some(user => user?.id === userId);
}

/**
 * True only when the account can actually be used right now — not "Sign in again".
 * Listed rows with invalid tokenStatus or missing stored token are NOT usable.
 */
export function isAccountActivelyUsable(userId: string): boolean {
    if (!isSnowflake(userId)) return false;

    try {
        if ((UserStore as any).getCurrentUser?.()?.id === userId) return true;
    } catch { }

    const entry = getSwitcherUsers().find(user => user?.id === userId);
    if (!entry) return false;

    if (typeof entry.tokenStatus === "number" && entry.tokenStatus === TOKEN_STATUS_INVALID) {
        return false;
    }

    return getStoredToken(userId) != null;
}

/** @deprecated Prefer isAccountActivelyUsable / isAccountListed. Kept as usable-session check for restore skip. */
export function isAccountAlreadyPresent(userId: string): boolean {
    return isAccountActivelyUsable(userId);
}

function updateSwitcherUser(userId: string, profile: any, tokenStatus: number) {
    const users = getSwitcherUsers();
    const index = users.findIndex(user => user?.id === userId);
    const next = toMultiAccountUser(userId, profile, tokenStatus);

    if (index >= 0) users[index] = next;
    else users.push(next);

    try {
        (MultiAccountStore as any)?.emitChange?.();
    } catch { }
}

export async function addAccountByToken(rawToken: string, options?: AddAccountOptions): Promise<AddTokenResult> {
    const token = normalizeToken(rawToken);
    if (!token) return { ok: false, reason: "empty" };

    const mode = options?.mode ?? "switch";
    const check = await identifyToken(token);
    if (check.state === "expired") return { ok: false, reason: "expired" };
    if (check.state !== "valid") return { ok: false, reason: "invalid" };

    const { user } = check;
    const displayName = typeof user.username === "string" && user.username
        ? user.username
        : `Account ${user.id}`;

    if (options?.expectedId && user.id !== options.expectedId) {
        logger.warn(`token was expected for ${options.expectedId} but belongs to ${user.id}`);
        return { ok: false, reason: "mismatch", username: displayName };
    }

    // Skip only truly usable sessions. "Sign in again" rows must be re-injected.
    if (isAccountActivelyUsable(user.id)) {
        storeTokenForUser(user.id, token);

        await loadSavedAccounts();
        const saved = saveableAccount(toMultiAccountUser(user.id, user, TOKEN_STATUS_VALID));
        if (saved) {
            savedAccounts[user.id] = saved;
            await persistSavedAccounts();
        }

        return {
            ok: true,
            alreadyPresent: true,
            reason: "already",
            username: saved?.username ?? displayName
        };
    }

    // Inject into switcher without tearing down the current session.
    if (mode === "switcher") {
        return restoreAccountToSwitcher({
            id: user.id,
            token,
            username: displayName,
            avatar: typeof user.avatar === "string" ? user.avatar : null,
            discriminator: typeof user.discriminator === "string" ? user.discriminator : "0",
            globalName: typeof user.globalName === "string"
                ? user.globalName
                : typeof user.global_name === "string"
                    ? user.global_name
                    : null
        });
    }

    if (!AuthActions || typeof (AuthActions as any).switchAccountToken !== "function") {
        return { ok: false, reason: "invalid" };
    }

    try {
        await (AuthActions as any).switchAccountToken(token);
    } catch (e) {
        logger.error(`switchAccountToken threw for ${user.id}`, e);
        return { ok: false, reason: "invalid", username: displayName };
    }

    // The switch reconnects the gateway under the hood; calling switchAccountToken again before
    // this settles can silently fail or throw, so batch adds must wait for it to land before
    // moving on to the next token.
    const switched = await waitForActiveUser(user.id);
    if (!switched) {
        logger.warn(`switchAccountToken for ${user.id} did not settle in time`);
        return { ok: false, reason: "timeout", username: displayName };
    }

    await loadSavedAccounts();
    const saved = saveableAccount(toMultiAccountUser(user.id, user, TOKEN_STATUS_VALID));
    if (saved) savedAccounts[user.id] = saved;
    await persistSavedAccounts();

    return { ok: true, username: saved?.username ?? user.username };
}

function extractTokensFromInput(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"') return [trimmed];

    try {
        const parsed = JSON.parse(trimmed);

        if (typeof parsed === "string") return [parsed];
        if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
        if (parsed && typeof parsed === "object") {
            return Object.values(parsed).filter((v): v is string => typeof v === "string" && v.length > 0);
        }

        return [];
    } catch {
        return [trimmed];
    }
}

export async function addAccountsFromInput(raw: string): Promise<AddTokensResult> {
    const tokens = extractTokensFromInput(raw);
    const result: AddTokensResult = { total: tokens.length, added: 0, skipped: 0, failed: 0, messages: [] };

    if (!tokens.length) {
        result.messages.push("Paste a token, or the JSON from \"Copy all as JSON\".");
        return result;
    }

    for (const token of tokens) {
        try {
            const r = await addAccountByToken(token);

            if (r.ok) {
                if (r.alreadyPresent) {
                    result.skipped++;
                    result.messages.push(`${r.username} is already logged in, skipped.`);
                    continue;
                }

                result.added++;
                result.messages.push(`Added ${r.username}.`);
                // Give the freshly-switched session a moment to finish settling before we hit
                // switchAccountToken again for the next one; back-to-back calls can otherwise fail.
                await sleep(750);
                continue;
            }

            result.failed++;
            result.messages.push(
                r.reason === "expired" ? "A token was expired." :
                    r.reason === "empty" ? "Skipped an empty token." :
                        r.reason === "timeout" ? "A switch didn't finish in time." :
                            r.reason === "mismatch" ? "A token belonged to a different user." :
                                r.reason === "store_failed" ? "Could not store the token locally." :
                                    "A token was invalid."
            );
        } catch (e) {
            logger.error("failed to add account from batch", e);
            result.failed++;
            result.messages.push("A token failed unexpectedly, check the console.");
        }
    }

    return result;
}

export function getKnownAccountTokens(): KnownAccountToken[] {
    const out: KnownAccountToken[] = [];

    for (const user of getSwitcherUsers()) {
        if (!isSnowflake(user?.id)) continue;

        const token = getStoredToken(user.id);
        if (!token) continue;

        out.push({
            id: user.id,
            username: user.username ?? user.globalName ?? `Account ${user.id}`,
            token
        });
    }

    return out;
}

export function getVaultSourceAccounts(): VaultSourceAccount[] {
    const out: VaultSourceAccount[] = [];

    for (const user of getSwitcherUsers()) {
        if (!isSnowflake(user?.id)) continue;

        const token = getStoredToken(user.id);
        if (!token) continue;

        const saved = normalizeSavedAccount(user) ?? savedAccounts[user.id];
        out.push({
            id: user.id,
            username: user.username ?? saved?.username ?? `Account ${user.id}`,
            avatar: typeof user.avatar === "string" ? user.avatar : saved?.avatar ?? null,
            discriminator: typeof user.discriminator === "string" ? user.discriminator : saved?.discriminator ?? "0",
            globalName: typeof user.globalName === "string"
                ? user.globalName
                : typeof user.global_name === "string"
                    ? user.global_name
                    : saved?.globalName ?? null,
            token
        });
    }

    return out;
}
