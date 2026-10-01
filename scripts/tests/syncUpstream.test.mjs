import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publisher = readFileSync(join(project, ".github/workflows/publish-devbuild.yml"), "utf8");

function workflowScript(name) {
    const lines = publisher.split("\n");
    const step = lines.findIndex(line => line.trim() === `- name: ${name}`);
    assert.notEqual(step, -1, `Missing workflow step: ${name}`);
    const run = lines.findIndex((line, index) => index > step && line.trim() === "run: |");
    assert.notEqual(run, -1, `Missing shell script: ${name}`);
    const indent = lines[run].length - lines[run].trimStart().length + 4;
    const script = [];
    for (const line of lines.slice(run + 1)) {
        if (line.trim() && line.length - line.trimStart().length < indent) break;
        script.push(line.slice(indent));
    }
    return script.join("\n");
}

function fixture(t) {
    const parent = join(project, "dist/temp");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "sync-upstream-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "source");
    const origin = join(root, "fork.git");
    const work = join(root, "work");
    const bin = join(root, "bin");
    const output = join(root, "output");
    const ghLog = join(root, "gh.jsonl");
    mkdirSync(source);
    mkdirSync(bin);
    const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_REPO: "TrapstarKS/Vencord",
        GH_TOKEN: "local-test-token",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_EVENT_NAME: "push",
        SYNC_START_SHA: "",
        MOCK_GH_LOG: ghLog,
        PATH: `${bin}:${process.env.PATH}`
    };
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const identify = cwd => {
        git(cwd, "config", "user.name", "Sync test");
        git(cwd, "config", "user.email", "sync-test@example.invalid");
        git(cwd, "config", "commit.gpgsign", "false");
    };
    const commit = (cwd, path, content) => {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
        git(cwd, "add", "--", path);
        git(cwd, "commit", "-m", `Update ${path}`);
        return git(cwd, "rev-parse", "HEAD");
    };
    git(source, "init", "--initial-branch=main");
    identify(source);
    commit(source, "shared.txt", "base\n");
    commit(source, ".github/workflows/upstream.yml", "name: Upstream\n");
    git(root, "clone", "--bare", source, origin);
    git(root, "clone", origin, work);
    identify(work);
    git(work, "remote", "add", "upstream", source);
    commit(work, "fork.txt", "keep fork changes\n");
    git(work, "push", "origin", "main");
    const head = git(work, "rev-parse", "HEAD");
    const hash = git(work, "rev-parse", "--short", "HEAD");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify({ args, repo: process.env.GH_REPO }) + "\\n");
const endpoint = args.find(arg => arg.startsWith("repos/"));
if (args[0] === "api") {
    if (process.env.MOCK_API_ERROR === "true") {
        process.stderr.write("Simulated API failure (HTTP 503)\\n");
        process.exit(7);
    }
    if (endpoint === "repos/TrapstarKS/Vencord/releases?per_page=100") {
        process.stdout.write(process.env.MOCK_RELEASE_STATE || "");
    } else if (endpoint === "repos/TrapstarKS/Vencord/git/ref/heads/main") {
        process.stdout.write(process.env.MOCK_MAIN_SHA || "");
    } else if (endpoint === "repos/TrapstarKS/Vencord/pulls") {
        if (!["state=open", "base=main", "head=TrapstarKS:sync/upstream"].every(field => args.includes(field))) {
            process.stderr.write("Incorrect pull request filters");
            process.exit(9);
        }
        const created = fs.readFileSync(process.env.MOCK_GH_LOG, "utf8").split("\\n").filter(Boolean)
            .some(line => JSON.parse(line).args[0] === "pr");
        process.stdout.write(process.env.MOCK_OPEN_PR_URL || (created && process.env.MOCK_CREATE_RACE === "true" ? "https://github.com/TrapstarKS/Vencord/pull/123" : ""));
    } else {
        process.stderr.write("Unexpected API request: " + JSON.stringify(args));
        process.exit(9);
    }
} else if (args[0] === "pr" && args[1] === "create") {
    if (args[args.indexOf("--repo") + 1] !== "TrapstarKS/Vencord" || args[args.indexOf("--head") + 1] !== "sync/upstream") {
        process.stderr.write("Incorrect pull request destination");
        process.exit(9);
    }
    if (process.env.MOCK_CREATE_ERROR === "true" || process.env.MOCK_CREATE_RACE === "true") {
        process.stderr.write("Simulated pull request creation failure\\n");
        process.exit(6);
    }
    process.stdout.write("https://github.com/TrapstarKS/Vencord/pull/123\\n");
} else if (args[0] === "release" && ["create", "upload", "edit"].includes(args[1])) {
    if (args[1] === "upload" && process.env.MOCK_UPLOAD_ERROR === "true") {
        process.stderr.write("Simulated upload failure\\n");
        process.exit(8);
    }
} else {
    process.stderr.write("Unexpected gh command: " + JSON.stringify(args));
    process.exit(9);
}
`, { mode: 0o755 });
    const run = (script, overrides = {}) => {
        writeFileSync(output, "");
        writeFileSync(ghLog, "");
        const result = spawnSync("bash", Array.isArray(script) ? script : ["-c", script], {
            cwd: work,
            env: { ...env, MOCK_MAIN_SHA: head, BUILD_COMMIT: head, BUILD_HASH: hash, RELEASE_EXISTS: "true", ...overrides },
            encoding: "utf8",
            timeout: 20000
        });
        assert.ifError(result.error);
        return result;
    };
    const outputs = () => Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map(line => line.split("=")));
    const calls = () => readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { root, source, origin, work, env, git, identify, commit, head, hash, run, outputs, calls };
}

function success(result) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

const prepare = workflowScript("Preparar publicação");
const publish = workflowScript('Publicar release "devbuild"');

test("publisher skips the commit already published before building", t => {
    const f = fixture(t);
    success(f.run(prepare, { MOCK_RELEASE_STATE: `exists|false|DevBuild ${f.hash}` }));
    assert.equal(f.outputs().publish, "false");
    assert.equal(f.outputs().commit, f.head);
    assert.equal(f.calls().length, 1);
});

test("publisher checks the published hash even when sync did not change main", t => {
    const f = fixture(t);
    success(f.run(prepare, { GITHUB_EVENT_NAME: "workflow_run", SYNC_START_SHA: f.head, MOCK_RELEASE_STATE: `exists|false|DevBuild ${f.hash}` }));
    assert.equal(f.outputs().publish, "false");
    assert.equal(f.calls().length, 1);
    success(f.run(prepare, { GITHUB_EVENT_NAME: "workflow_run", SYNC_START_SHA: f.head, MOCK_RELEASE_STATE: "exists|false|DevBuild previous" }));
    assert.equal(f.outputs().publish, "true");
});

test("publisher builds a new commit against an existing release", t => {
    const f = fixture(t);
    success(f.run(prepare, { MOCK_RELEASE_STATE: "exists|false|DevBuild oldhash" }));
    assert.equal(f.outputs().publish, "true");
    assert.equal(f.outputs().release_exists, "true");
});

test("publisher distinguishes a missing release from API failure", t => {
    const f = fixture(t);
    success(f.run(prepare));
    assert.equal(f.outputs().publish, "true");
    assert.equal(f.outputs().release_exists, "false");
    const failure = f.run(prepare, { MOCK_API_ERROR: "true" });
    assert.equal(failure.status, 7);
    assert.equal(f.outputs().publish, undefined);
    assert.equal(f.outputs().release_exists, undefined);
});

test("publisher does not consider a draft hash successfully published", t => {
    const f = fixture(t);
    success(f.run(prepare, { MOCK_RELEASE_STATE: `exists|true|DevBuild ${f.hash}` }));
    assert.equal(f.outputs().publish, "true");
    assert.equal(f.outputs().release_exists, "true");
});

test("publisher never uploads when main advanced during the build", t => {
    const f = fixture(t);
    const advanced = f.commit(f.work, "new.txt", "new main\n");
    success(f.run(publish, { MOCK_MAIN_SHA: advanced, RELEASE_EXISTS: "false" }));
    assert.equal(f.calls().length, 1);
    assert.equal(f.calls()[0].args[0], "api");
});

test("publisher does not upload when reading current main fails", t => {
    const f = fixture(t);
    assert.equal(f.run(publish, { MOCK_API_ERROR: "true" }).status, 7);
    assert.equal(f.calls().length, 1);
});

test("publisher creates a draft and marks its hash only after all uploads", t => {
    const f = fixture(t);
    success(f.run(publish, { RELEASE_EXISTS: "false" }));
    const mutations = f.calls().filter(call => call.args[0] === "release");
    assert.deepEqual(mutations.map(call => call.args[1]), ["create", "upload", "edit"]);
    assert.ok(mutations[0].args.includes("--draft"));
    assert.ok(mutations[0].args.includes(f.head));
    assert.ok(!mutations[0].args.includes(`DevBuild ${f.hash}`));
    assert.ok(mutations[2].args.includes(`DevBuild ${f.hash}`));
    assert.ok(mutations[2].args.includes("--draft=false"));
    for (const call of mutations) {
        assert.equal(call.args[call.args.indexOf("--repo") + 1], "TrapstarKS/Vencord");
    }
});

test("publisher retains the previous completion marker after a failed upload", t => {
    const f = fixture(t);
    assert.equal(f.run(publish, { MOCK_UPLOAD_ERROR: "true" }).status, 8);
    assert.deepEqual(f.calls().filter(call => call.args[0] === "release").map(call => call.args[1]), ["upload"]);
});

function sync(f, overrides = {}) {
    f.git(f.work, "fetch", "upstream", "main");
    return f.run([join(project, "scripts/sync-upstream.sh")], overrides);
}

function conflictingChanges(f) {
    f.commit(f.source, "shared.txt", "upstream\n");
    const start = f.commit(f.work, "shared.txt", "fork\n");
    f.git(f.work, "push", "origin", "main");
    return start;
}

test("sync does nothing when upstream is already an ancestor", t => {
    const f = fixture(t);
    success(sync(f));
    assert.equal(f.outputs().status, "noop");
    assert.equal(f.git(f.origin, "rev-parse", "main"), f.head);
    assert.equal(f.git(f.work, "rev-parse", "HEAD"), f.head);
    assert.deepEqual(f.calls(), []);
});

test("sync merges code and workflow changes while preserving fork history", t => {
    const f = fixture(t);
    f.commit(f.source, "new.txt", "new upstream code\n");
    const upstream = f.commit(f.source, ".github/workflows/upstream.yml", "name: Updated upstream\n");
    success(sync(f));
    assert.equal(f.outputs().status, "updated");
    const merged = f.git(f.work, "rev-parse", "HEAD");
    assert.equal(f.git(f.origin, "rev-parse", "main"), merged);
    assert.deepEqual(f.git(f.work, "show", "-s", "--format=%P", "HEAD").split(" "), [f.head, upstream]);
    assert.equal(f.git(f.work, "show", "HEAD:fork.txt"), "keep fork changes");
    assert.equal(f.git(f.work, "show", "HEAD:.github/workflows/upstream.yml"), "name: Updated upstream");
    assert.deepEqual(f.calls(), []);
});

test("sync aborts real conflicts and opens a PR from a branch in the fork", t => {
    const f = fixture(t);
    const start = conflictingChanges(f);
    success(sync(f));
    assert.equal(f.outputs().status, "review");
    assert.equal(f.git(f.work, "rev-parse", "HEAD"), start);
    assert.equal(f.git(f.origin, "rev-parse", "main"), start);
    assert.equal(f.git(f.work, "status", "--porcelain"), "");
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), f.git(f.source, "rev-parse", "HEAD"));
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api", "pr"]);
    success(sync(f, { MOCK_OPEN_PR_URL: "https://github.com/TrapstarKS/Vencord/pull/123" }));
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api"]);
});

test("sync preserves manual branch commits and reuses the open PR", t => {
    const f = fixture(t);
    const base = f.git(f.source, "rev-parse", "HEAD");
    f.git(f.work, "switch", "-c", "sync/upstream", base);
    const manual = f.commit(f.work, "manual.txt", "keep conflict resolution work\n");
    f.git(f.work, "push", "origin", "sync/upstream");
    f.git(f.work, "switch", "main");
    conflictingChanges(f);
    success(sync(f, { MOCK_OPEN_PR_URL: "https://github.com/TrapstarKS/Vencord/pull/123" }));
    assert.equal(f.outputs().status, "review");
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), manual);
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api"]);
});

test("sync fast-forwards an earlier upstream review branch", t => {
    const f = fixture(t);
    f.git(f.work, "push", "origin", "HEAD~1:refs/heads/sync/upstream");
    conflictingChanges(f);
    success(sync(f, { MOCK_OPEN_PR_URL: "https://github.com/TrapstarKS/Vencord/pull/123" }));
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), f.git(f.source, "rev-parse", "HEAD"));
});

test("sync reports operational merge failures without inventing conflict PRs", t => {
    const f = fixture(t);
    f.commit(f.source, "collision.txt", "upstream file\n");
    writeFileSync(join(f.work, "collision.txt"), "untracked work\n");
    const result = sync(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /falhou sem produzir conflitos/);
    assert.equal(f.outputs().status, undefined);
    assert.equal(f.git(f.work, "rev-parse", "HEAD"), f.head);
    assert.equal(readFileSync(join(f.work, "collision.txt"), "utf8"), "untracked work\n");
    assert.deepEqual(f.calls(), []);
});

test("sync propagates PR lookup errors and never treats closed PRs as open", t => {
    const f = fixture(t);
    conflictingChanges(f);
    assert.equal(sync(f, { MOCK_API_ERROR: "true" }).status, 7);
    assert.equal(f.outputs().status, undefined);
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api"]);
    assert.equal(sync(f, { MOCK_CREATE_ERROR: "true" }).status, 6);
    assert.equal(f.outputs().status, undefined);
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api", "pr", "api"]);
});

test("sync tolerates a PR created between lookup and creation", t => {
    const f = fixture(t);
    conflictingChanges(f);
    success(sync(f, { MOCK_CREATE_RACE: "true" }));
    assert.equal(f.outputs().status, "review");
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api", "pr", "api"]);
});

test("sync never overwrites main when another writer advances it", t => {
    const f = fixture(t);
    const other = join(f.root, "other");
    f.git(f.root, "clone", f.origin, other);
    f.identify(other);
    const advanced = f.commit(other, "other.txt", "concurrent change\n");
    f.git(other, "push", "origin", "main");
    f.commit(f.source, "new.txt", "upstream change\n");
    assert.notEqual(sync(f).status, 0);
    assert.equal(f.git(f.origin, "rev-parse", "main"), advanced);
    assert.equal(f.outputs().status, undefined);
    assert.deepEqual(f.calls(), []);
});

test("sync rejects a review-branch push raced by manual work", t => {
    const f = fixture(t);
    f.git(f.work, "push", "origin", "HEAD~1:refs/heads/sync/upstream");
    const manual = conflictingChanges(f);
    writeFileSync(join(f.work, ".git/hooks/pre-push"), '#!/usr/bin/env bash\ngit --git-dir="$MOCK_ORIGIN" update-ref refs/heads/sync/upstream "$MOCK_RACE_SHA"\n', { mode: 0o755 });
    assert.notEqual(sync(f, { MOCK_ORIGIN: f.origin, MOCK_RACE_SHA: manual }).status, 0);
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), manual);
    assert.equal(f.outputs().status, undefined);
    assert.deepEqual(f.calls(), []);
});

function integratedReview(f) {
    f.git(f.work, "switch", "-c", "sync/upstream");
    const integrated = f.commit(f.work, "shared.txt", "previous manual resolution\n");
    f.git(f.work, "push", "origin", "sync/upstream");
    f.git(f.work, "switch", "main");
    f.git(f.work, "merge", "--ff-only", "sync/upstream");
    f.git(f.work, "push", "origin", "main");
    f.commit(f.source, "shared.txt", "new upstream conflict\n");
    return integrated;
}

test("sync recycles a previous resolution only after it is integrated in main", t => {
    const f = fixture(t);
    const integrated = integratedReview(f);
    success(sync(f));
    assert.equal(f.outputs().status, "review");
    assert.equal(f.git(f.origin, "rev-parse", "main"), integrated);
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), f.git(f.source, "rev-parse", "HEAD"));
    assert.deepEqual(f.calls().map(call => call.args[0]), ["api", "pr"]);
});

test("sync uses an exact lease when recycling an integrated review branch", t => {
    const f = fixture(t);
    const integrated = integratedReview(f);
    f.git(f.work, "switch", "-c", "later-work");
    const manual = f.commit(f.work, "later.txt", "pending manual work\n");
    f.git(f.work, "push", "origin", "later-work");
    f.git(f.work, "switch", "main");
    writeFileSync(join(f.work, ".git/hooks/pre-push"), '#!/usr/bin/env bash\ngit --git-dir="$MOCK_ORIGIN" update-ref refs/heads/sync/upstream "$MOCK_RACE_SHA"\n', { mode: 0o755 });
    assert.notEqual(sync(f, { MOCK_ORIGIN: f.origin, MOCK_RACE_SHA: manual }).status, 0);
    assert.equal(f.git(f.origin, "rev-parse", "main"), integrated);
    assert.equal(f.git(f.origin, "rev-parse", "sync/upstream"), manual);
    assert.equal(f.outputs().status, undefined);
    assert.deepEqual(f.calls(), []);
});
