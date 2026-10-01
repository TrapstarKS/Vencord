/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import EventEmitter from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { buildSync } from "esbuild";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const entryPoint = path.join(projectRoot, "src/main/persistAfterDiscordUpdates.ts");
const { outputFiles } = buildSync({
    absWorkingDir: projectRoot,
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "original-fs"],
    logLevel: "silent"
});
const script = new Script(outputFiles[0].text, { filename: entryPoint });
const originalEmit = EventEmitter.prototype.emit;
const patcher = Buffer.from("\0require('/fixture/global/Vencord/patcher.js');\0");
const discordOriginal = Buffer.concat([
    Buffer.from("Discord host app-1.0.10\n"),
    Buffer.from([0, 255, 128, 13, 10])
]);

function fixture(t, { platform = "win32", env = {}, candidate = discordOriginal, backup } = {}) {
    const dist = path.join(projectRoot, "dist");
    fs.mkdirSync(dist, { recursive: true });
    const root = fs.mkdtempSync(path.join(dist, "persist-after-updates-test-"));
    const errors = [];
    const writes = [];
    t.after(() => {
        try {
            assert.deepEqual(errors, [], "The real module logged an unexpected error");
            assert.equal(EventEmitter.prototype.emit, originalEmit, "The Node EventEmitter must stay untouched");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    const currentResources = path.join(root, "app-1.0.9", "resources");
    const newResources = path.join(root, "app-1.0.10", "resources");
    fs.mkdirSync(currentResources, { recursive: true });
    fs.mkdirSync(newResources, { recursive: true });
    fs.writeFileSync(path.join(currentResources, "app.asar"), patcher);
    fs.writeFileSync(path.join(currentResources, "_app.asar"), "Current host's original Discord archive");
    fs.writeFileSync(path.join(newResources, "app.asar"), candidate);
    const newBackup = path.join(newResources, "_app.asar");
    if (backup !== undefined) fs.writeFileSync(newBackup, backup);

    const snapshot = () => [currentResources, newResources].map(dir => Object.fromEntries(
        fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))])
    ));
    const initialSnapshot = snapshot();

    class FixtureEventEmitter extends EventEmitter {
        emit(...args) {
            return super.emit(...args);
        }
    }
    const app = new FixtureEventEmitter();
    const updater = new FixtureEventEmitter();
    const originalFs = {};
    for (const [method, pathCount] of Object.entries({
        existsSync: 1,
        readdirSync: 1,
        readFileSync: 1,
        statSync: 1,
        renameSync: 2,
        copyFileSync: 2
    })) {
        originalFs[method] = (...args) => {
            const files = args.slice(0, pathCount);
            for (const file of files) {
                const relative = path.relative(root, path.resolve(file));
                assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
                    `File access outside fixture: ${file}`);
            }
            if (pathCount === 2) writes.push([method, ...files]);
            return fs[method](...args);
        };
    }
    const modules = {
        electron: { app },
        events: FixtureEventEmitter,
        "node:events": FixtureEventEmitter,
        "original-fs": originalFs,
        path,
        "node:path": path
    };
    const module = { exports: {} };
    script.runInNewContext({
        Buffer,
        module,
        exports: module.exports,
        process: {
            platform,
            env: { ...env },
            execPath: path.join(root, "app-1.0.9", platform === "win32" ? "Discord.exe" : "Discord")
        },
        require(id) {
            assert.ok(Object.hasOwn(modules, id), `Unexpected module: ${id}`);
            return modules[id];
        },
        console: {
            info() { },
            warn() { },
            error(...args) { errors.push(args); }
        }
    }, { timeout: 1000 });

    return { app, updater, writes, newBackup, snapshot, initialSnapshot };
}

function assertUntouched(state) {
    assert.deepEqual(state.writes, [], "No filesystem mutation may be attempted");
    assert.deepEqual(state.snapshot(), state.initialSnapshot);
}

function assertPatched(state, original = discordOriginal) {
    assert.deepEqual(state.snapshot(), [
        state.initialSnapshot[0],
        { "_app.asar": original, "app.asar": patcher }
    ]);
}

function emitBoth(state, ...args) {
    state.updater.emit("host-updated", ...args);
    state.app.emit("before-quit", ...args);
}

for (const platform of ["win32", "linux"]) {
    for (const event of ["host-updated", "before-quit"]) {
        test(`${platform}: ${event} preserves the original and replays without writes`, t => {
            const state = fixture(t, { platform });
            const emitter = event === "host-updated" ? state.updater : state.app;
            const args = [{ version: "1.0.10" }, "update payload"];
            let delivered = 0;
            emitter.on(event, function (...received) {
                assert.equal(this, emitter);
                assert.deepEqual(received, args);
                assertPatched(state);
                delivered++;
            });

            assertUntouched(state);
            assert.equal(emitter.emit(event, ...args), true);
            assert.equal(delivered, 1);
            assertPatched(state);
            const firstWrites = state.writes.length;
            assert.ok(firstWrites > 0);

            emitBoth(state, ...args);
            assert.equal(delivered, 2);
            assertPatched(state);
            assert.equal(state.writes.length, firstWrites, "Replayed events must not rewrite either archive");
        });
    }

    test(`${platform}: DISABLE_UPDATER_AUTO_PATCHING prevents writes from both events`, t => {
        const state = fixture(t, { platform, env: { DISABLE_UPDATER_AUTO_PATCHING: "1" } });
        emitBoth(state);
        assertUntouched(state);
    });
}

test("a foreign Vencord bootstrap without _app.asar is never nested", t => {
    const state = fixture(t, { candidate: Buffer.from("\0require('/fixture/fork/dist/patcher.js');\0") });
    assert.equal(fs.existsSync(state.newBackup), false);
    emitBoth(state);
    assertUntouched(state);
});

test("an existing backup and its host archive are preserved", t => {
    const state = fixture(t, { backup: Buffer.from("Pre-existing original that must never be overwritten") });
    emitBoth(state);
    assertUntouched(state);
});

test("darwin leaves archives untouched for both events", t => {
    const state = fixture(t, { platform: "darwin" });
    emitBoth(state);
    assertUntouched(state);
});

test("unrelated events preserve their receiver, arguments and return value without patching", t => {
    const state = fixture(t);
    const args = [{ percent: 50 }, "download"];
    let delivered = 0;
    state.updater.on("download-progress", function (...received) {
        assert.equal(this, state.updater);
        assert.deepEqual(received, args);
        delivered++;
    });
    assert.equal(state.updater.emit("download-progress", ...args), true);
    assert.equal(delivered, 1);
    assert.equal(state.updater.emit("unhandled-event"), false);
    assertUntouched(state);
});

test("a full host archive mentioning patcher.js is backed up as the original", t => {
    const original = Buffer.alloc(128 * 1024, 65);
    original.write("patcher.js", 1024);
    const state = fixture(t, { candidate: original });
    state.updater.emit("host-updated");
    assertPatched(state, original);
});
