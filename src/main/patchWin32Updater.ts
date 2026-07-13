/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "original-fs";
import { basename, dirname, join } from "path";

function isNewer($new: string, old: string) {
    const newParts = $new.slice(4).split(".").map(Number);
    const oldParts = old.slice(4).split(".").map(Number);

    for (let i = 0; i < oldParts.length; i++) {
        if (newParts[i] > oldParts[i]) return true;
        if (newParts[i] < oldParts[i]) return false;
    }
    return false;
}

function isVencordBootstrap(file: string) {
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

function patchLatest() {
    if (process.env.DISABLE_UPDATER_AUTO_PATCHING) return;

    try {
        const currentAppPath = dirname(process.execPath);
        const currentVersion = basename(currentAppPath);
        const discordPath = join(currentAppPath, "..");

        const latestVersion = readdirSync(discordPath).reduce((prev, curr) => {
            return (curr.startsWith("app-") && isNewer(curr, prev))
                ? curr
                : prev;
        }, currentVersion as string);

        if (latestVersion === currentVersion) return;

        const resources = join(discordPath, latestVersion, "resources");
        const app = join(resources, "app.asar");
        const _app = join(resources, "_app.asar");

        if (!existsSync(app) || statSync(app).isDirectory()) return;

        // Another Vencord build may already own this host version. This commonly happens when
        // a dev build is injected while an older/global Vencord instance is still running: its
        // before-quit auto-patcher sees the freshly-patched app.asar and would otherwise wrap it
        // a second time, losing the real Discord backup and crashing on duplicate IPC handlers.
        if (existsSync(_app) || isVencordBootstrap(app)) {
            console.warn("[Vencord] Host update is already patched by another Vencord instance; skipping nested auto-patch");
            return;
        }

        console.info("[Vencord] Detected Host Update. Repatching...");

        renameSync(app, _app);
        mkdirSync(app);
        writeFileSync(join(app, "package.json"), JSON.stringify({
            name: "discord",
            main: "index.js"
        }));
        writeFileSync(join(app, "index.js"), `require(${JSON.stringify(join(__dirname, "patcher.js"))});`);
    } catch (err) {
        console.error("[Vencord] Failed to repatch latest host update", err);
    }
}

// Try to patch latest on before-quit
// Discord's Win32 updater will call app.quit() on restart and open new version on will-quit
app.on("before-quit", patchLatest);
