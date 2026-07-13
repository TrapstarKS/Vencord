/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { UserStore } from "@webpack/common";

import {
    addAccountByToken,
    type AddTokenResult,
    getCachedAvatarDataUrl,
    getVaultSourceAccounts,
    isAccountActivelyUsable,
    markCurrentSessionTokenHealthy,
    rememberAvatarFromCdn,
    restoreAccountToSwitcher,
    type TokenHealthStatus,
    validateTokenForUser,
    VaultSourceAccount
} from "./accounts";

const logger = new Logger("MoreAccounts:Vault");

const DATA_KEY = "MoreAccounts_encryptedVault_v1";
const INDEX_KEY = "MoreAccounts_vaultAccountIndex_v1";
const MAGIC = "VencordMoreAccountsVault";
const VERSION = 1;
const KDF_ITERATIONS = 600_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_BACKUP_SIZE = 20 * 1024 * 1024;

interface VaultAccount {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
    /** Optional local label (e.g. "main", "work") — never a secret. */
    note: string | null;
    token: string;
    updatedAt: string;
}

interface VaultPayload {
    version: 1;
    accounts: Record<string, VaultAccount>;
}

interface VaultEnvelope {
    magic: typeof MAGIC;
    version: typeof VERSION;
    kdf: {
        name: "PBKDF2";
        hash: "SHA-256";
        iterations: number;
        salt: string;
    };
    cipher: {
        name: "AES-256-GCM";
        iv: string;
    };
    createdAt: string;
    updatedAt: string;
    accountCount: number;
    ciphertext: string;
}

export interface PublicVaultAccount {
    id: string;
    username: string;
    avatar: string | null;
    discriminator: string;
    globalName: string | null;
    note: string | null;
    updatedAt: string;
}

export interface VaultSnapshot {
    exists: boolean;
    unlocked: boolean;
    accountCount: number;
    updatedAt: string | null;
    accounts: PublicVaultAccount[];
}

export interface VaultSyncResult {
    added: number;
    updated: number;
}

export interface VaultImportResult extends VaultSyncResult {
    unchanged: number;
}

export interface VaultRestoreResult {
    total: number;
    restored: number;
    skipped: number;
    failed: number;
    messages: string[];
}

interface VaultAccountIndexEntry {
    username: string;
    globalName: string | null;
}

/** Non-secret public index of vaulted user IDs (for locked-vault prompts). */
interface VaultAccountIndex {
    ready: boolean;
    accounts: Record<string, VaultAccountIndexEntry>;
}

let envelope: VaultEnvelope | null = null;
let key: CryptoKey | null = null;
let payload: VaultPayload | null = null;
let accountIndex: VaultAccountIndex = { ready: false, accounts: {} };
let initialized = false;
let mutationQueue: Promise<unknown> = Promise.resolve();

const listeners = new Set<() => void>();

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function randomBase64(length: number): string {
    return bytesToBase64(crypto.getRandomValues(new Uint8Array(length)));
}

function getAdditionalData(value: Omit<VaultEnvelope, "ciphertext">): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        magic: value.magic,
        version: value.version,
        kdf: value.kdf,
        cipher: value.cipher,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        accountCount: value.accountCount
    }));
}

function isEnvelope(value: any): value is VaultEnvelope {
    return value?.magic === MAGIC
        && value?.version === VERSION
        && value?.kdf?.name === "PBKDF2"
        && value?.kdf?.hash === "SHA-256"
        && Number.isInteger(value?.kdf?.iterations)
        && value.kdf.iterations >= 100_000
        && value.kdf.iterations <= 2_000_000
        && typeof value?.kdf?.salt === "string"
        && value.kdf.salt.length >= 20
        && value.kdf.salt.length <= 128
        && value?.cipher?.name === "AES-256-GCM"
        && typeof value?.cipher?.iv === "string"
        && value.cipher.iv.length >= 16
        && value.cipher.iv.length <= 64
        && typeof value?.createdAt === "string"
        && typeof value?.updatedAt === "string"
        && Number.isInteger(value?.accountCount)
        && value.accountCount >= 0
        && typeof value?.ciphertext === "string"
        && value.ciphertext.length <= MAX_BACKUP_SIZE;
}

function isValidVaultAccountEntry(id: string, account: any): boolean {
    return isSnowflake(id)
        && id.length <= 32
        && account?.id === id
        && typeof account?.token === "string"
        && account.token.length >= 20
        && account.token.length <= 4096;
}

function normalizePayload(value: any): VaultPayload {
    if (value?.version !== VERSION || value?.accounts == null || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
        throw new Error("This backup contains invalid vault data.");
    }

    const accounts: Record<string, VaultAccount> = {};
    let skipped = 0;

    for (const [id, account] of Object.entries(value.accounts) as Array<[string, any]>) {
        // Skip garbage rows (e.g. soft-logout wrote i18n keys as ids) instead of failing unlock.
        if (!isValidVaultAccountEntry(id, account)) {
            skipped++;
            logger.warn("normalizePayload: skipping invalid vault account", id);
            continue;
        }

        accounts[id] = {
            id,
            username: typeof account.username === "string" && account.username ? account.username : `Account ${id}`,
            avatar: typeof account.avatar === "string" ? account.avatar : null,
            discriminator: typeof account.discriminator === "string" ? account.discriminator : "0",
            globalName: typeof account.globalName === "string" ? account.globalName : null,
            note: typeof account.note === "string" && account.note.trim()
                ? account.note.trim().slice(0, 64)
                : null,
            token: account.token,
            updatedAt: typeof account.updatedAt === "string" ? account.updatedAt : new Date(0).toISOString()
        };
    }

    if (skipped) logger.warn(`normalizePayload: skipped ${skipped} invalid account(s)`);

    return { version: VERSION, accounts };
}

async function deriveKey(password: string, value: VaultEnvelope): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(new TextEncoder().encode(password)),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            hash: value.kdf.hash,
            iterations: value.kdf.iterations,
            salt: toArrayBuffer(base64ToBytes(value.kdf.salt))
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function decryptEnvelope(value: VaultEnvelope, password: string): Promise<{ key: CryptoKey; payload: VaultPayload; scrubbed: number; }> {
    let derivedKey: CryptoKey;
    let plaintext: ArrayBuffer;

    try {
        derivedKey = await deriveKey(password, value);
        const additionalData = getAdditionalData(value);
        plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: toArrayBuffer(base64ToBytes(value.cipher.iv)),
                additionalData: toArrayBuffer(additionalData)
            },
            derivedKey,
            toArrayBuffer(base64ToBytes(value.ciphertext))
        );
    } catch (error) {
        logger.warn("failed to decrypt vault (crypto)", error);
        throw new Error("Wrong password, corrupted file, or unsupported backup.");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
        logger.warn("failed to parse vault plaintext", error);
        throw new Error("Wrong password, corrupted file, or unsupported backup.");
    }

    const before = parsed && typeof parsed === "object" && (parsed as any).accounts && typeof (parsed as any).accounts === "object"
        ? Object.keys((parsed as any).accounts).length
        : 0;
    const payload = normalizePayload(parsed);
    const after = Object.keys(payload.accounts).length;

    return {
        key: derivedKey,
        payload,
        scrubbed: Math.max(0, before - after)
    };
}

async function encryptPayload(value: VaultPayload, encryptionKey: CryptoKey, previous: VaultEnvelope): Promise<VaultEnvelope> {
    const now = new Date().toISOString();
    const next: Omit<VaultEnvelope, "ciphertext"> = {
        magic: MAGIC,
        version: VERSION,
        kdf: previous.kdf,
        cipher: {
            name: "AES-256-GCM",
            iv: randomBase64(12)
        },
        createdAt: previous.createdAt,
        updatedAt: now,
        accountCount: Object.keys(value.accounts).length
    };
    const additionalData = getAdditionalData(next);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: toArrayBuffer(base64ToBytes(next.cipher.iv)),
            additionalData: toArrayBuffer(additionalData)
        },
        encryptionKey,
        toArrayBuffer(plaintext)
    );

    return { ...next, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

function notify() {
    for (const listener of listeners) listener();
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(() => void 0, () => void 0);
    return next;
}

function buildIndexFromPayload(value: VaultPayload): VaultAccountIndex {
    const accounts: Record<string, VaultAccountIndexEntry> = {};
    for (const account of Object.values(value.accounts)) {
        accounts[account.id] = {
            username: account.username,
            globalName: account.globalName
        };
    }
    return { ready: true, accounts };
}

async function persistAccountIndex(next: VaultAccountIndex) {
    accountIndex = next;
    await DataStore.set(INDEX_KEY, next);
}

async function writeIndexFromPayload(value: VaultPayload) {
    await persistAccountIndex(buildIndexFromPayload(value));
}

async function clearAccountIndex() {
    accountIndex = { ready: false, accounts: {} };
    await DataStore.del(INDEX_KEY);
}

function normalizeAccountIndex(value: unknown): VaultAccountIndex {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ready: false, accounts: {} };
    }

    const raw = value as any;
    if (raw.ready !== true || raw.accounts == null || typeof raw.accounts !== "object" || Array.isArray(raw.accounts)) {
        return { ready: false, accounts: {} };
    }

    const accounts: Record<string, VaultAccountIndexEntry> = {};
    for (const [id, entry] of Object.entries(raw.accounts) as Array<[string, any]>) {
        if (!isSnowflake(id)) continue;
        accounts[id] = {
            username: typeof entry?.username === "string" && entry.username ? entry.username : `Account ${id}`,
            globalName: typeof entry?.globalName === "string" ? entry.globalName : null
        };
    }

    return { ready: true, accounts };
}

async function persistUnlockedVault() {
    if (!envelope || !key || !payload) throw new Error("Unlock the vault first.");
    envelope = await encryptPayload(payload, key, envelope);
    await DataStore.set(DATA_KEY, envelope);
    await writeIndexFromPayload(payload);
    notify();
}

function accountChanged(current: VaultAccount, incoming: Omit<VaultAccount, "updatedAt">) {
    return current.token !== incoming.token
        || current.username !== incoming.username
        || current.avatar !== incoming.avatar
        || current.discriminator !== incoming.discriminator
        || current.globalName !== incoming.globalName
        || (current.note ?? null) !== (incoming.note ?? null);
}

function withPreservedNote(
    source: VaultSourceAccount,
    current: VaultAccount | undefined,
    now: string
): VaultAccount {
    return {
        id: source.id,
        username: source.username,
        avatar: source.avatar,
        discriminator: source.discriminator,
        globalName: source.globalName,
        note: current?.note ?? null,
        token: source.token,
        updatedAt: now
    };
}

function publicAccount(account: VaultAccount): PublicVaultAccount {
    const { token: _, ...safe } = account;
    return safe;
}

export async function initializeVault() {
    if (initialized) return;

    const [stored, storedIndex] = await Promise.all([
        DataStore.get<unknown>(DATA_KEY),
        DataStore.get<unknown>(INDEX_KEY)
    ]);
    envelope = isEnvelope(stored) ? stored : null;
    accountIndex = envelope ? normalizeAccountIndex(storedIndex) : { ready: false, accounts: {} };
    if (!envelope && storedIndex != null) await DataStore.del(INDEX_KEY).catch(() => void 0);
    initialized = true;
    notify();
}

export function subscribeVault(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getVaultSnapshot(): VaultSnapshot {
    const accounts = payload
        ? Object.values(payload.accounts)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map(publicAccount)
        : [];

    return {
        exists: envelope != null,
        unlocked: key != null && payload != null,
        accountCount: payload ? accounts.length : envelope?.accountCount ?? 0,
        updatedAt: envelope?.updatedAt ?? null,
        accounts
    };
}

export function isVaultIndexReady() {
    return accountIndex.ready;
}

/**
 * Switcher accounts that have a token but are not yet recorded in the public vault index.
 * Only meaningful when a vault exists, is locked, and the index has been written at least once.
 */
export function getMissingVaultAccounts(): VaultSourceAccount[] {
    if (!envelope || (key != null && payload != null) || !accountIndex.ready) return [];

    return getVaultSourceAccounts().filter(account => accountIndex.accounts[account.id] == null);
}

/** Returns the raw token only while the vault is unlocked in this session. */
export function getUnlockedVaultToken(userId: string): string | null {
    if (!key || !payload || !isSnowflake(userId)) return null;
    const token = payload.accounts[userId]?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
}

/** Public profile fields from an unlocked vault entry (no token). */
export function getUnlockedVaultProfile(userId: string): PublicVaultAccount | null {
    if (!key || !payload || !isSnowflake(userId)) return null;
    const account = payload.accounts[userId];
    return account ? publicAccount(account) : null;
}

export function getVaultAvatarUrl(account: PublicVaultAccount, size = 80): string {
    // Prefer a locally cached data URL (survives soft-logout / CDN hash changes).
    const cached = getCachedAvatarDataUrl(account.id);
    if (cached) return cached;

    if (account.avatar) {
        const extension = account.avatar.startsWith("a_") ? "gif" : "webp";
        const url = `https://cdn.discordapp.com/avatars/${account.id}/${account.avatar}.${extension}?size=${size}`;
        void rememberAvatarFromCdn(account.id, url);
        return url;
    }

    let index = Number(account.discriminator) % 5;
    if (!account.discriminator || account.discriminator === "0") {
        try {
            index = Number((BigInt(account.id) >> 22n) % 6n);
        } catch {
            index = 0;
        }
    }

    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function createVault(password: string): Promise<VaultSyncResult> {
    return enqueue(async () => {
        if (password.length < MIN_PASSWORD_LENGTH) {
            throw new Error(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
        }

        const now = new Date().toISOString();
        const emptyEnvelope: VaultEnvelope = {
            magic: MAGIC,
            version: VERSION,
            kdf: {
                name: "PBKDF2",
                hash: "SHA-256",
                iterations: KDF_ITERATIONS,
                salt: randomBase64(16)
            },
            cipher: {
                name: "AES-256-GCM",
                iv: randomBase64(12)
            },
            createdAt: now,
            updatedAt: now,
            accountCount: 0,
            ciphertext: ""
        };

        const derivedKey = await deriveKey(password, emptyEnvelope);
        const accounts: Record<string, VaultAccount> = {};
        for (const account of getVaultSourceAccounts()) {
            accounts[account.id] = withPreservedNote(account, undefined, now);
        }

        envelope = emptyEnvelope;
        key = derivedKey;
        payload = { version: VERSION, accounts };
        await persistUnlockedVault();

        return { added: Object.keys(accounts).length, updated: 0 };
    });
}

export function unlockVault(password: string): Promise<number> {
    return enqueue(async () => {
        await initializeVault();
        if (!envelope) throw new Error("No local vault exists yet.");

        const decrypted = await decryptEnvelope(envelope, password);
        key = decrypted.key;
        payload = decrypted.payload;

        // Persist if garbage rows were dropped during normalize, so the bad ciphertext is rewritten.
        if (decrypted.scrubbed) {
            logger.warn(`scrubbed ${decrypted.scrubbed} invalid vault account(s) on unlock`);
            await persistUnlockedVault();
        } else {
            // Legacy vaults get an index on first unlock so new-account prompts can work afterwards.
            await writeIndexFromPayload(payload);
        }
        notify();
        return decrypted.scrubbed;
    });
}

/**
 * Re-encrypt the vault under a new password. Requires the current password so data is never
 * rewritten without proof of access. Without the current password, the only option is deleteVault().
 */
export function changeVaultPassword(currentPassword: string, newPassword: string): Promise<void> {
    return enqueue(async () => {
        await initializeVault();
        if (!envelope) throw new Error("No local vault exists yet.");

        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            throw new Error(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
        }
        if (currentPassword === newPassword) {
            throw new Error("The new password must be different from the current one.");
        }

        // Always verify against the on-disk envelope (works locked or unlocked).
        const decrypted = await decryptEnvelope(envelope, currentPassword);

        const now = new Date().toISOString();
        const nextBase: VaultEnvelope = {
            magic: MAGIC,
            version: VERSION,
            kdf: {
                name: "PBKDF2",
                hash: "SHA-256",
                iterations: KDF_ITERATIONS,
                salt: randomBase64(16)
            },
            cipher: {
                name: "AES-256-GCM",
                iv: randomBase64(12)
            },
            createdAt: envelope.createdAt,
            updatedAt: now,
            accountCount: Object.keys(decrypted.payload.accounts).length,
            ciphertext: ""
        };

        const newKey = await deriveKey(newPassword, nextBase);
        payload = decrypted.payload;
        key = newKey;
        envelope = await encryptPayload(payload, newKey, nextBase);
        await DataStore.set(DATA_KEY, envelope);
        await writeIndexFromPayload(payload);
        notify();
    });
}

export function lockVault() {
    key = null;
    payload = null;
    notify();
}

export function deleteVault(): Promise<void> {
    return enqueue(async () => {
        key = null;
        payload = null;
        envelope = null;
        await DataStore.del(DATA_KEY);
        await clearAccountIndex();
        notify();
    });
}

export function syncVaultFromDiscord(): Promise<VaultSyncResult> {
    return enqueue(async () => {
        if (!envelope || !key || !payload) return { added: 0, updated: 0 };

        const result: VaultSyncResult = { added: 0, updated: 0 };
        const now = new Date().toISOString();

        for (const source of getVaultSourceAccounts()) {
            const current = payload.accounts[source.id];
            const incoming = withPreservedNote(source, current, now);

            if (!current) {
                payload.accounts[source.id] = incoming;
                result.added++;
            } else if (accountChanged(current, incoming)) {
                payload.accounts[source.id] = incoming;
                result.updated++;
            }

            if (source.avatar) {
                const extension = source.avatar.startsWith("a_") ? "gif" : "webp";
                void rememberAvatarFromCdn(
                    source.id,
                    `https://cdn.discordapp.com/avatars/${source.id}/${source.avatar}.${extension}?size=80`
                );
            }
        }

        if (result.added || result.updated) await persistUnlockedVault();
        return result;
    });
}

/** Persist one account into the unlocked vault (used by soft-logout before Discord drops the token). */
export function saveAccountToUnlockedVault(account: VaultSourceAccount): Promise<boolean> {
    return enqueue(async () => {
        if (!envelope || !key || !payload) return false;

        // Never write garbage rows (non-snowflake ids / empty tokens) — soft-logout once saved "multi_accounts_list".
        if (!isSnowflake(account.id)
            || account.id.length > 32
            || typeof account.token !== "string"
            || account.token.length < 20
            || account.token.length > 4096) {
            logger.warn("saveAccountToUnlockedVault: rejected invalid account", account.id);
            return false;
        }

        const now = new Date().toISOString();
        const current = payload.accounts[account.id];

        // Keep previous avatar/nick/note if the new write is missing them (soft-logout race).
        const incoming: VaultAccount = {
            id: account.id,
            username: typeof account.username === "string" && account.username && !account.username.startsWith("Account ")
                ? account.username
                : (current?.username && !current.username.startsWith("Account ")
                    ? current.username
                    : (typeof account.username === "string" && account.username ? account.username : `Account ${account.id}`)),
            avatar: typeof account.avatar === "string"
                ? account.avatar
                : current?.avatar ?? null,
            discriminator: typeof account.discriminator === "string" && account.discriminator !== "0"
                ? account.discriminator
                : current?.discriminator ?? "0",
            globalName: typeof account.globalName === "string"
                ? account.globalName
                : current?.globalName ?? null,
            note: current?.note ?? null,
            token: account.token,
            updatedAt: now
        };

        if (!current || accountChanged(current, incoming)) {
            payload.accounts[account.id] = incoming;
            await persistUnlockedVault();
        }

        if (incoming.avatar) {
            const extension = incoming.avatar.startsWith("a_") ? "gif" : "webp";
            void rememberAvatarFromCdn(
                incoming.id,
                `https://cdn.discordapp.com/avatars/${incoming.id}/${incoming.avatar}.${extension}?size=80`
            );
        }
        return true;
    });
}

/** Set or clear a short local label for a vault account (while unlocked). */
export function setVaultAccountNote(userId: string, note: string | null): Promise<void> {
    return enqueue(async () => {
        if (!envelope || !key || !payload) throw new Error("Unlock the vault first.");
        if (!isSnowflake(userId) || !payload.accounts[userId]) {
            throw new Error("That account is not in the vault.");
        }

        const trimmed = typeof note === "string" ? note.trim().slice(0, 64) : "";
        payload.accounts[userId] = {
            ...payload.accounts[userId],
            note: trimmed || null,
            updatedAt: new Date().toISOString()
        };
        await persistUnlockedVault();
    });
}

/** Remove one account from the unlocked vault (does not log out of Discord). */
export function removeVaultAccount(userId: string): Promise<void> {
    return enqueue(async () => {
        if (!envelope || !key || !payload) throw new Error("Unlock the vault first.");
        if (!isSnowflake(userId) || !payload.accounts[userId]) {
            throw new Error("That account is not in the vault.");
        }

        delete payload.accounts[userId];
        await persistUnlockedVault();
    });
}

/**
 * Switch the active Discord session to a vault account (full switchAccountToken).
 */
export function switchToVaultAccount(userId: string): Promise<AddTokenResult> {
    return enqueue(async () => {
        if (!payload || !key) throw new Error("Unlock the vault first.");
        if (!isSnowflake(userId)) throw new Error("Invalid account id.");

        const account = payload.accounts[userId];
        if (!account) throw new Error("That account is not in the vault.");

        return addAccountByToken(account.token, { mode: "switch", expectedId: account.id });
    });
}

export interface VaultTokenHealthSummary {
    total: number;
    valid: number;
    invalid: number;
    mismatch: number;
    unknown: number;
}

/**
 * Probe every unlocked vault token against Discord and update health badges.
 * The active session is marked valid without an extra request.
 */
export async function checkUnlockedVaultTokenHealth(): Promise<VaultTokenHealthSummary> {
    if (!payload || !key) throw new Error("Unlock the vault first.");

    const summary: VaultTokenHealthSummary = {
        total: 0,
        valid: 0,
        invalid: 0,
        mismatch: 0,
        unknown: 0
    };

    let currentId: string | null = null;
    try {
        currentId = (UserStore as any).getCurrentUser?.()?.id ?? null;
    } catch {
        currentId = null;
    }

    const accounts = Object.values(payload.accounts);
    // Sequential with a tiny delay so we don't spam /users/@me.
    for (const account of accounts) {
        summary.total++;
        let health: TokenHealthStatus;

        if (currentId && account.id === currentId) {
            markCurrentSessionTokenHealthy(account.id);
            health = "valid";
        } else {
            health = await validateTokenForUser(account.id, account.token);
            // Be gentle on Discord's API.
            await new Promise(r => setTimeout(r, 150));
        }

        if (health === "valid") summary.valid++;
        else if (health === "invalid") summary.invalid++;
        else if (health === "mismatch") summary.mismatch++;
        else summary.unknown++;
    }

    return summary;
}

/** Drop vault rows with non-snowflake ids or empty tokens (cleanup after soft-logout bugs). */
export function scrubInvalidVaultAccounts(): Promise<number> {
    return enqueue(async () => {
        if (!envelope || !key || !payload) return 0;

        let removed = 0;
        for (const id of Object.keys(payload.accounts)) {
            const account = payload.accounts[id];
            const bad = !isSnowflake(id)
                || id.length > 32
                || typeof account?.token !== "string"
                || account.token.length < 20
                || account.token.length > 4096
                || account.id !== id;

            if (bad) {
                delete payload.accounts[id];
                removed++;
            }
        }

        if (removed) await persistUnlockedVault();
        return removed;
    });
}

export function exportVaultBackup(): Promise<string> {
    return enqueue(async () => {
        if (!envelope) throw new Error("No vault exists yet.");

        if (key && payload) {
            const now = new Date().toISOString();
            let changed = false;
            for (const source of getVaultSourceAccounts()) {
                const current = payload.accounts[source.id];
                const incoming = withPreservedNote(source, current, now);
                if (!current || accountChanged(current, incoming)) {
                    payload.accounts[source.id] = incoming;
                    changed = true;
                }
            }
            if (changed) await persistUnlockedVault();
        }

        return JSON.stringify(envelope, null, 2);
    });
}

export function importVaultBackup(raw: string, password: string): Promise<VaultImportResult> {
    return enqueue(async () => {
        if (raw.length > MAX_BACKUP_SIZE) throw new Error("That backup file is too large.");

        let importedEnvelope: unknown;
        try {
            importedEnvelope = JSON.parse(raw);
        } catch {
            throw new Error("That file is not a valid MoreAccounts backup.");
        }

        if (!isEnvelope(importedEnvelope)) throw new Error("That file is not a supported MoreAccounts backup.");
        const imported = await decryptEnvelope(importedEnvelope, password);

        if (!envelope) {
            envelope = importedEnvelope;
            key = imported.key;
            payload = imported.payload;
            initialized = true;
            if (imported.scrubbed) {
                await persistUnlockedVault();
            } else {
                await DataStore.set(DATA_KEY, envelope);
                await writeIndexFromPayload(payload);
            }
            notify();
            return { added: Object.keys(payload.accounts).length, updated: 0, unchanged: 0 };
        }

        if (!key || !payload) throw new Error("Unlock the local vault before merging another backup.");

        const result: VaultImportResult = { added: 0, updated: 0, unchanged: 0 };
        for (const account of Object.values(imported.payload.accounts)) {
            const current = payload.accounts[account.id];
            if (!current) {
                payload.accounts[account.id] = account;
                result.added++;
            } else if (current.token !== account.token && account.updatedAt > current.updatedAt) {
                payload.accounts[account.id] = account;
                result.updated++;
            } else {
                result.unchanged++;
            }
        }

        if (result.added || result.updated) await persistUnlockedVault();
        return result;
    });
}

export function restoreVaultAccounts(ids?: string[]): Promise<VaultRestoreResult> {
    return enqueue(async () => {
        if (!payload || !key) throw new Error("Unlock the vault first.");

        const selected = ids?.length
            ? ids.map(id => payload!.accounts[id]).filter((account): account is VaultAccount => account != null)
            : Object.values(payload.accounts);
        const result: VaultRestoreResult = { total: selected.length, restored: 0, skipped: 0, failed: 0, messages: [] };

        for (const account of selected) {
            const label = account.globalName ?? account.username;

            try {
                // Skip only fully usable sessions. "Sign in again" rows are repaired below.
                if (isAccountActivelyUsable(account.id)) {
                    result.skipped++;
                    result.messages.push(`${label}: already active, skipped.`);
                    continue;
                }

                // Same strategy as hidden-account restore: inject token + switcher row,
                // keep the current session, allow soft validation (unknown ≠ fail).
                const restored = await restoreAccountToSwitcher({
                    id: account.id,
                    token: account.token,
                    username: account.username,
                    avatar: account.avatar,
                    discriminator: account.discriminator,
                    globalName: account.globalName
                });
                if (restored.ok && restored.alreadyPresent) {
                    result.skipped++;
                    result.messages.push(`${label}: already active, skipped.`);
                } else if (restored.ok && restored.repaired) {
                    result.restored++;
                    result.messages.push(`${label}: re-applied vault token (was “sign in again”).`);
                } else if (restored.ok) {
                    result.restored++;
                    result.messages.push(`${label} restored.`);
                } else {
                    result.failed++;
                    const why =
                        restored.reason === "expired" ? "token expired — log in again with password/token" :
                            restored.reason === "mismatch" ? "token belongs to another user" :
                                restored.reason === "store_failed" ? "could not save token into Discord storage" :
                                    restored.reason === "timeout" ? "switch timed out" :
                                        restored.reason === "empty" ? "empty token" :
                                            "token invalid or Discord rejected the restore";
                    result.messages.push(`${label}: ${why}.`);
                }
            } catch (error) {
                logger.error(`failed to restore ${account.id} from vault`, error);
                result.failed++;
                result.messages.push(`${label}: unexpected error.`);
            }
        }

        return result;
    });
}
