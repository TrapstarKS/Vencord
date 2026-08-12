/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { app, IpcMainInvokeEvent } from "electron";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

const STORAGE_DIR = join(app.getPath("appData"), "Vencord", "MoreAccounts");
const STORAGE_PATH = join(STORAGE_DIR, "shared-vault.json");
const LEGACY_STORAGE_DIR = join(DATA_DIR, "MoreAccounts");
const LEGACY_STORAGE_PATH = join(LEGACY_STORAGE_DIR, "shared-vault.json");
const MAX_STORAGE_SIZE = 25 * 1024 * 1024;

export interface SharedVaultStorage {
    envelope: unknown | null;
    index: unknown | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStorage(value: unknown): SharedVaultStorage {
    if (!isObject(value)) throw new Error("MoreAccounts shared vault has an invalid format.");
    return {
        envelope: value.envelope ?? null,
        index: value.index ?? null
    };
}

async function removeTempFiles(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.startsWith("shared-vault.json.") && entry.name.endsWith(".tmp"))
        .map(entry => rm(join(directory, entry.name), { force: true }).catch(() => void 0)));
}

async function readStorageAt(path: string): Promise<SharedVaultStorage | null> {
    try {
        const raw = await readFile(path, "utf8");
        if (Buffer.byteLength(raw, "utf8") > MAX_STORAGE_SIZE) {
            throw new Error("MoreAccounts shared vault is too large.");
        }
        return normalizeStorage(JSON.parse(raw));
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

export async function readVaultStorage(event: IpcMainInvokeEvent): Promise<SharedVaultStorage | null> {
    const current = await readStorageAt(STORAGE_PATH);
    if (current) return current;

    if (LEGACY_STORAGE_PATH === STORAGE_PATH) return null;
    const legacy = await readStorageAt(LEGACY_STORAGE_PATH);
    if (!legacy) return null;

    await writeVaultStorage(event, legacy.envelope, legacy.index);
    return legacy;
}

function isSamePath(first: string, second: string) {
    return first.toLowerCase() === second.toLowerCase();
}

async function removeVaultFile(path: string) {
    await rm(path, { force: true });
}

export async function writeVaultStorage(
    _: IpcMainInvokeEvent,
    envelope: unknown | null,
    index: unknown | null
): Promise<void> {
    const serialized = JSON.stringify({ envelope, index });
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORAGE_SIZE) {
        throw new Error("MoreAccounts shared vault is too large.");
    }

    await mkdir(STORAGE_DIR, { recursive: true });
    const temporaryPath = `${STORAGE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });

    try {
        await rename(temporaryPath, STORAGE_PATH);
    } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        await rm(STORAGE_PATH, { force: true });
        await rename(temporaryPath, STORAGE_PATH);
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => void 0);
    }
}

export async function deleteVaultStorage(_: IpcMainInvokeEvent): Promise<void> {
    await removeVaultFile(STORAGE_PATH);
    if (!isSamePath(LEGACY_STORAGE_PATH, STORAGE_PATH)) await removeVaultFile(LEGACY_STORAGE_PATH);
    await Promise.all([
        removeTempFiles(STORAGE_DIR),
        isSamePath(LEGACY_STORAGE_DIR, STORAGE_DIR) ? Promise.resolve() : removeTempFiles(LEGACY_STORAGE_DIR)
    ]);
}
