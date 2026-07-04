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
const DEFAULT_MAX_ACCOUNTS = 50;
const MIN_ACCOUNTS = 5;
const TOKEN_STATUS_INVALID = 0;
const TOKEN_STATUS_VALID = 2;

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

export interface AddTokenResult {
    ok: boolean;
    reason?: "empty" | "invalid" | "expired" | "already-active";
    username?: string;
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
    const rest = await checkWithRest(id, token);
    if (rest.state === "valid" || rest.state === "expired") return rest;

    const fetched = await checkWithFetch(id, token);
    if (fetched.state !== "unknown") return fetched;

    return rest;
}

async function identifyToken(token: string): Promise<TokenCheck> {
    try {
        const res: any = await (RestAPI as any).get({
            url: "/users/@me",
            headers: { authorization: token }
        });

        const user = res?.body;
        if (isSnowflake(user?.id)) return { state: "valid", user };

        return { state: "unknown" };
    } catch (e) {
        if (isAuthFailureStatus(getErrorStatus(e))) return { state: "expired" };

        try {
            const res = await fetch(`${location.origin}/api/v9/users/@me`, {
                headers: { authorization: token },
                credentials: "omit"
            });

            if (isAuthFailureStatus(res.status)) return { state: "expired" };
            if (!res.ok) return { state: "unknown", error: e };

            const user = await res.json().catch(() => null);
            if (isSnowflake(user?.id)) return { state: "valid", user };

            return { state: "unknown" };
        } catch (e2) {
            return { state: "unknown", error: e2 };
        }
    }
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
            if (normalized) savedAccounts[normalized.id] = normalized;
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
            changed = true;
        }

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

export async function addAccountByToken(rawToken: string): Promise<AddTokenResult> {
    const token = rawToken.trim();
    if (!token) return { ok: false, reason: "empty" };

    const check = await identifyToken(token);
    if (check.state === "expired") return { ok: false, reason: "expired" };
    if (check.state !== "valid") return { ok: false, reason: "invalid" };

    const { user } = check;
    if (user.id === (UserStore as any).getCurrentUser?.()?.id) {
        return { ok: false, reason: "already-active" };
    }

    if (!AuthActions || typeof (AuthActions as any).switchAccountToken !== "function") {
        return { ok: false, reason: "invalid" };
    }

    await (AuthActions as any).switchAccountToken(token);

    await loadSavedAccounts();
    const saved = saveableAccount(toMultiAccountUser(user.id, user, TOKEN_STATUS_VALID));
    if (saved) savedAccounts[user.id] = saved;
    await persistSavedAccounts();

    return { ok: true, username: saved?.username ?? user.username };
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
