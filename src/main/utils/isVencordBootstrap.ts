/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, statSync } from "original-fs";

export function isVencordBootstrap(file: string) {
    try {
        // Installer-generated app.asar files are tiny archives whose payload contains the
        // absolute path to a Vencord patcher. Never treat one as Discord's original app.asar.
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 64 * 1024) return false;

        return readFileSync(file).includes(Buffer.from("patcher.js"));
    } catch {
        return false;
    }
}
