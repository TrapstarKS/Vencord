/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { localStorage } from "@utils/localStorage";
import definePlugin, { OptionType } from "@utils/types";
import { FluxStore } from "@vencord/discord-types";
import { find, findLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

const STORAGE_KEY = "vc-questNotifier-seen-v1";

const settings = definePluginSettings({
    enrollCheckIntervalHours: {
        type: OptionType.NUMBER,
        description: "De quantas em quantas horas checar e se matricular automaticamente em quests novas",
        default: 1
    },
    watchVideo: {
        type: OptionType.BOOLEAN,
        description: "Completar automaticamente quests do tipo Assistir vídeo",
        default: true
    },
    playOnDesktop: {
        type: OptionType.BOOLEAN,
        description: "Completar automaticamente quests do tipo Jogar no desktop",
        default: true
    },
    streamOnDesktop: {
        type: OptionType.BOOLEAN,
        description: "Completar automaticamente quests do tipo Transmitir no desktop",
        default: true
    },
    playActivity: {
        type: OptionType.BOOLEAN,
        description: "Completar automaticamente quests do tipo Atividade em call",
        default: true
    }
});

const TASK_LABELS: Record<string, string> = {
    WATCH_VIDEO: "Assistir vídeo",
    WATCH_VIDEO_ON_MOBILE: "Assistir vídeo",
    PLAY_ON_DESKTOP: "Jogar no desktop",
    STREAM_ON_DESKTOP: "Transmitir no desktop",
    PLAY_ACTIVITY: "Atividade em call"
};

type QuestTaskConfig = {
    tasks?: Record<string, { target?: number; }>;
};

type Quest = {
    id: string;
    config?: {
        expiresAt?: string;
        messages?: {
            questName?: string;
        };
        taskConfig?: QuestTaskConfig;
        taskConfigV2?: QuestTaskConfig;
        application?: { id: string };
        configVersion?: number;
    };
    userStatus?: {
        enrolledAt?: string;
        completedAt?: string;
        progress?: Record<string, { value: number }>;
        streamProgressSeconds?: number;
    };
};

type QuestsStoreType = FluxStore & {
    quests: Map<string, Quest>;
    getQuest: (...a: any[]) => any;
};

// The Discord i18n message Proxy returns a non-undefined value for *any* accessed
// property (including method names), so a weak "has this property" filter can match
// it instead of the real store. Require multiple methods AND a real Map instance.
function isValidQuestsStore(x: any): x is QuestsStoreType {
    return !!x
        && x.quests instanceof Map
        && typeof x.getQuest === "function"
        && typeof x.addChangeListener === "function"
        && typeof x.removeChangeListener === "function"
        && typeof x.emitChange === "function";
}

let QuestsStore: QuestsStoreType | null = null;

async function resolveQuestsStore(maxAttempts = 10, delayMs = 1500) {
    console.log("[QuestNotifier] Resolving QuestsStore...");
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = find(isValidQuestsStore, { isIndirect: true });
        if (candidate) {
            console.log(`[QuestNotifier] QuestsStore found (attempt ${i + 1}/${maxAttempts}).`);
            return candidate as QuestsStoreType;
        }
        console.log(`[QuestNotifier] QuestsStore not found yet (attempt ${i + 1}/${maxAttempts}), retrying in ${delayMs}ms...`);
        await sleep(delayMs);
    }
    console.log("[QuestNotifier] Gave up resolving QuestsStore.");
    return null;
}

// The store itself can resolve before Discord has fetched the actual quest list into
// it (the Map starts empty), so wait for it to be populated before the first scan.
async function waitForQuestsLoaded(store: QuestsStoreType, maxAttempts = 20, delayMs = 1000) {
    console.log(`[QuestNotifier] Waiting for quests to load (current size: ${store.quests.size})...`);
    for (let i = 0; i < maxAttempts; i++) {
        if (store.quests.size > 0) {
            console.log(`[QuestNotifier] Quests loaded: ${store.quests.size} quest(s) after ${i} attempt(s).`);
            return;
        }
        if (stopCompletions) {
            console.log("[QuestNotifier] Stopped while waiting for quests to load.");
            return;
        }
        await sleep(delayMs);
    }
    console.log(`[QuestNotifier] Timed out waiting for quests to load (still ${store.quests.size}).`);
}

// ------------ Notification / seen tracking ------------
let seenIds: Set<string> | null = null;
let shouldBaseline = true;
const enrollingIds = new Set<string>();
const enrolledIds = new Set<string>();
const failedEnrollIds = new Set<string>();

function loadSeenIds() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? new Set<string>(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function saveSeenIds() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...seenIds!]));
}

function getTaskLabel(quest: Quest) {
    const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
    const taskName = taskConfig && Object.keys(taskConfig.tasks ?? {}).find(name => TASK_LABELS[name]);
    return (taskName && TASK_LABELS[taskName]) ?? "Quest";
}

function formatExpiry(expiresAt: string) {
    const date = new Date(expiresAt);
    return Number.isNaN(date.getTime()) ? "data desconhecida" : date.toLocaleString();
}

function isExpired(quest: Quest) {
    const expiresAt = quest.config?.expiresAt;
    if (!expiresAt) return false;
    const time = new Date(expiresAt).getTime();
    return !Number.isNaN(time) && time <= Date.now();
}

function shouldEnroll(quest: Quest) {
    return (
        !quest.userStatus?.enrolledAt &&
        !quest.userStatus?.completedAt &&
        !isExpired(quest) &&
        !enrollingIds.has(quest.id) &&
        !enrolledIds.has(quest.id) &&
        !failedEnrollIds.has(quest.id)
    );
}

async function enrollQuest(quest: Quest) {
    if (!shouldEnroll(quest)) return Boolean(quest.userStatus?.enrolledAt || enrolledIds.has(quest.id));

    console.log(`[QuestNotifier] Enrolling: ${quest.config?.messages?.questName}`);
    enrollingIds.add(quest.id);
    try {
        const res = await RestAPI.post({
            url: `/quests/${quest.id}/enroll`,
            body: {
                location: 11,
                is_targeted: false,
                metadata_sealed: null
            }
        } as any);

        quest.userStatus = res.body;
        enrolledIds.add(quest.id);
        QuestsStore!.emitChange();
        console.log(`[QuestNotifier] Enrolled: ${quest.config?.messages?.questName}`);
        return true;
    } catch (e) {
        failedEnrollIds.add(quest.id);
        console.log(`[QuestNotifier] Enroll failed: ${quest.config?.messages?.questName}`, e);
        return false;
    } finally {
        enrollingIds.delete(quest.id);
    }
}

function notifyNewQuest(quest: Quest) {
    const expiresAt = quest.config?.expiresAt;
    const questName = quest.config?.messages?.questName ?? "Quest sem nome";

    console.log(`[QuestNotifier] New quest detected: ${questName}`);
    showNotification({
        title: "Nova Quest disponível",
        body: `${questName} · ${getTaskLabel(quest)} · expira em ${expiresAt ? formatExpiry(expiresAt) : "data desconhecida"}`
    });
}

function notificationCheck() {
    const { quests } = QuestsStore!;
    console.log(`[QuestNotifier] notificationCheck: ${quests?.size ?? 0} quest(s) in store.`);
    if (!quests || quests.size === 0) return;

    if (shouldBaseline) {
        seenIds = new Set([...quests.values()].map(quest => quest.id));
        saveSeenIds();
        shouldBaseline = false;
        console.log(`[QuestNotifier] Baseline set with ${seenIds.size} known quest id(s).`);
        return;
    }

    const currentIds = new Set<string>();
    const seen = seenIds ?? (seenIds = new Set<string>());
    let changed = false;

    for (const quest of quests.values()) {
        currentIds.add(quest.id);
        if (seen.has(quest.id)) continue;

        seen.add(quest.id);
        changed = true;

        const expiresAt = quest.config?.expiresAt;
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) continue;

        notifyNewQuest(quest);
    }

    for (const id of seen) {
        if (!currentIds.has(id)) {
            seen.delete(id);
            changed = true;
        }
    }

    if (changed) saveSeenIds();
}

// ------------ Auto‑completion helpers ------------
const supportedTasks = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
const isApp = true;
const processedIds = new Set<string>(); // quests already in the queue
const pending: Quest[] = []; // queue of quests to complete
let stopCompletions = false;

// Lazy‑found stores used by spoofers
const ApplicationStreamingStore = findLazy(m => m.A?.getStreamerActiveStreamMetadata).A;
const RunningGameStore = findLazy(m => m.Ay?.getRunningGames).Ay;
const ChannelStore = findStoreLazy("ChannelStore");
const GuildChannelStore = findStoreLazy("GuildChannelStore") as FluxStore & {
    getAllGuilds(): Record<string, { VOCAL?: Array<{ channel?: { id?: string; }; }>; }>;
};

// Helper to freeze native function names for spoofing
const _defProp = Object.defineProperty.bind(Object);
function spoofNative(fn: Function, name: string) {
    const w = function (this: any, ...a: any[]) { return fn.apply(this, a); };
    _defProp(w, "name", { value: name, configurable: true });
    return w;
}

// Random normal delay (bell curve)
function bell(center: number, spread: number) {
    let s = 0;
    for (let i = 0; i < 6; i++) s += Math.random();
    return Math.max(0, center + (s - 3) * spread);
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

// Background activity to mimic human behaviour
async function doBackgroundActivity() {
    try {
        const dms = ChannelStore.getSortedPrivateChannels().slice(0, 8);
        if (dms.length === 0) return;
        const ch = dms[Math.floor(Math.random() * dms.length)];
        await RestAPI.get({ url: `/channels/${ch.id}/messages?limit=${Math.floor(Math.random() * 30) + 10}` });
    } catch (_) { }
}

async function idleWait(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (stopCompletions) return;
        const chunk = Math.min(end - Date.now(), bell(45000, 10000));
        await sleep(chunk);
        if (Date.now() < end && Math.random() < 0.15) await doBackgroundActivity();
    }
}

function isEligibleForCompletion(q: Quest) {
    return (
        q.userStatus?.enrolledAt &&
        !q.userStatus?.completedAt &&
        new Date(q.config!.expiresAt!).getTime() > Date.now() &&
        supportedTasks.find(y => Object.keys((q.config!.taskConfig ?? q.config!.taskConfigV2)!.tasks!).includes(y))
    );
}

function enqueueEligible(quests: Quest[]) {
    for (const q of quests) {
        if (processedIds.has(q.id)) continue;
        processedIds.add(q.id);
        pending.push(q);
        console.log(`[QuestNotifier] Queued: ${q.config?.messages?.questName}`);
    }
}

const TASK_SETTING_KEYS: Record<string, "watchVideo" | "playOnDesktop" | "streamOnDesktop" | "playActivity"> = {
    WATCH_VIDEO: "watchVideo",
    WATCH_VIDEO_ON_MOBILE: "watchVideo",
    PLAY_ON_DESKTOP: "playOnDesktop",
    STREAM_ON_DESKTOP: "streamOnDesktop",
    PLAY_ACTIVITY: "playActivity"
};

function isTaskEnabled(taskName: string) {
    const key = TASK_SETTING_KEYS[taskName];
    return !!key && !!settings.store[key];
}

function isSupported(q: Quest) {
    const taskName = supportedTasks.find(y => Object.keys((q.config?.taskConfig ?? q.config?.taskConfigV2)?.tasks ?? {}).includes(y));
    return !!taskName && isTaskEnabled(taskName);
}

function getEnrollCheckDelayMs() {
    const hours = settings.store.enrollCheckIntervalHours;
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1;
    const center = Math.max(safeHours, 0.05) * 60 * 60 * 1000; // floor of 3min to avoid a tight loop on invalid/0 input
    return bell(center, center / 6);
}

// ------------ Enrollment watcher ------------
// Mirrors V2.js's watchNewQuests: polls periodically and enrolls one quest at a
// time with human-like delays, instead of enrolling everything instantly/in parallel.
async function watchNewQuestsLoop() {
    console.log("[QuestNotifier] watchNewQuestsLoop started.");
    while (!stopCompletions) {
        console.log("[QuestNotifier] watchNewQuestsLoop: scanning for new/unenrolled quests...");
        const all = [...QuestsStore!.quests.values()].filter(q =>
            !q.userStatus?.completedAt &&
            !isExpired(q) &&
            isSupported(q)
        );
        console.log(`[QuestNotifier] watchNewQuestsLoop: ${all.length} supported quest(s) found.`);

        const unenrolled = all.filter(shouldEnroll);
        console.log(`[QuestNotifier] watchNewQuestsLoop: ${unenrolled.length} quest(s) need enrolling.`);
        for (const q of unenrolled) {
            if (stopCompletions) break;
            try {
                await sleep(bell(8000, 2200));
                const enrolled = await enrollQuest(q);
                if (enrolled) {
                    await sleep(bell(2500, 400));
                    // Queue it up right away instead of waiting for the next scan cycle (~1h by default).
                    if (isEligibleForCompletion(q)) enqueueEligible([q]);
                }
            } catch (e) {
                console.log(`[QuestNotifier] Enroll failed for ${q.config?.messages?.questName}:`, e);
            }
        }

        const eligible = all.filter(isEligibleForCompletion);
        console.log(`[QuestNotifier] watchNewQuestsLoop: ${eligible.length} quest(s) eligible for the completion queue.`);
        enqueueEligible(eligible);

        if (stopCompletions) break;
        const delayMs = getEnrollCheckDelayMs();
        console.log(`[QuestNotifier] watchNewQuestsLoop: next scan in ${Math.round(delayMs / 1000)}s.`);
        await sleep(delayMs);
    }
    console.log("[QuestNotifier] watchNewQuestsLoop stopped.");
}

// ------------ Quest completion handlers ------------
async function watchVideo(quest: Quest, secondsNeeded: number, secondsDone: number) {
    console.log(`[QuestNotifier] watchVideo: ${quest.config?.messages?.questName} (${secondsDone}/${secondsNeeded}s done)`);
    let done = secondsDone;
    let completed = false;
    let speed = 7;

    while (!stopCompletions) {
        speed = Math.max(4, Math.min(11, speed + bell(0, 0.9) - 0.45));
        const remaining = Math.min(speed, secondsNeeded - done);
        const bufferPause = Math.random() < 0.05 ? bell(5500, 1000) : 0;
        await sleep(bell(remaining * 1000, remaining * 130) + bufferPause);

        const timestamp = done + speed;
        const res = await RestAPI.post({
            url: `/quests/${quest.id}/video-progress`,
            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random() * 0.9) }
        });
        completed = res.body.completed_at != null;
        done = Math.min(secondsNeeded, timestamp);
        if (timestamp >= secondsNeeded) break;
    }

    if (!completed) {
        await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
    }
    console.log(`[QuestNotifier] Done: ${quest.config?.messages?.questName}`);
}

async function playOnDesktop(quest: Quest, applicationId: string, secondsNeeded: number, secondsDone: number, pid: number) {
    console.log(`[QuestNotifier] playOnDesktop: ${quest.config?.messages?.questName} (${secondsDone}/${secondsNeeded}s done)`);
    const res = await RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` });
    const appData = res.body[0];
    const exeName = appData.executables?.find((x: any) => x.os === "win32")?.name?.replace(">", "")
        ?? appData.name.replace(/[/\\:*?"<>|]/g, "");

    const fakeGame = {
        cmdLine: `C:\\Games\\${appData.name}\\bin\\${exeName} --launch`,
        exeName,
        exePath: `c:/games/${appData.name.toLowerCase()}/bin/${exeName}`,
        hidden: false,
        isLauncher: false,
        id: applicationId,
        name: appData.name,
        pid,
        pidPath: [pid, pid + 4],
        processName: appData.name,
        start: Date.now() - (300 + Math.floor(Math.random() * 300)) * 1000,
    };

    const realGet = RunningGameStore.getRunningGames;
    const realGetPID = RunningGameStore.getGameForPID;

    _defProp(RunningGameStore, "getRunningGames", {
        value: spoofNative(() => [fakeGame], "getRunningGames"),
        writable: true, configurable: true, enumerable: true
    });
    _defProp(RunningGameStore, "getGameForPID", {
        value: spoofNative((p: number) => fakeGame.pid === p ? fakeGame : null, "getGameForPID"),
        writable: true, configurable: true, enumerable: true
    });
    FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        removed: realGet.call(RunningGameStore),
        added: [fakeGame],
        games: [fakeGame]
    });

    console.log(`[QuestNotifier] Game spoofed. ${Math.ceil((secondsNeeded - secondsDone) / 60)} min remaining.`);

    await new Promise<void>(resolve => {
        const fn = (data: any) => {
            if (stopCompletions) {
                cleanup();
                resolve();
                return;
            }
            const progress = quest.config?.configVersion === 1
                ? data.userStatus.streamProgressSeconds
                : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);
            console.log(`[QuestNotifier] ${progress}/${secondsNeeded}`);
            if (progress >= secondsNeeded) {
                cleanup();
                resolve();
            }
        };
        function cleanup() {
            _defProp(RunningGameStore, "getRunningGames", { value: realGet, writable: true, configurable: true, enumerable: true });
            _defProp(RunningGameStore, "getGameForPID", { value: realGetPID, writable: true, configurable: true, enumerable: true });
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        }
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
    });

    console.log(`[QuestNotifier] Done: ${quest.config?.messages?.questName}`);
}

async function streamOnDesktop(quest: Quest, applicationId: string, secondsNeeded: number, pid: number) {
    console.log(`[QuestNotifier] streamOnDesktop: ${quest.config?.messages?.questName}`);
    const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    _defProp(ApplicationStreamingStore, "getStreamerActiveStreamMetadata", {
        value: spoofNative(() => ({ id: applicationId, pid, sourceName: "" }), "getStreamerActiveStreamMetadata"),
        writable: true, configurable: true, enumerable: true,
    });
    console.log("[QuestNotifier] Remember: at least 1 person in vc!");

    await new Promise<void>(resolve => {
        const fn = (data: any) => {
            if (stopCompletions) {
                cleanup();
                resolve();
                return;
            }
            const progress = quest.config?.configVersion === 1
                ? data.userStatus.streamProgressSeconds
                : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
            console.log(`[QuestNotifier] ${progress}/${secondsNeeded}`);
            if (progress >= secondsNeeded) {
                cleanup();
                resolve();
            }
        };
        function cleanup() {
            _defProp(ApplicationStreamingStore, "getStreamerActiveStreamMetadata", { value: realFunc, writable: true, configurable: true, enumerable: true });
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        }
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
    });

    console.log(`[QuestNotifier] Done: ${quest.config?.messages?.questName}`);
}

async function playActivity(quest: Quest, secondsNeeded: number) {
    console.log(`[QuestNotifier] playActivity: ${quest.config?.messages?.questName}`);
    const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id
        ?? Object.values(GuildChannelStore.getAllGuilds()).find(x => x?.VOCAL?.length)?.VOCAL?.[0]?.channel?.id;
    const streamKey = `call:${channelId}:1`;
    if (!channelId) console.log("[QuestNotifier] playActivity: no voice channel found for stream_key!");

    while (!stopCompletions) {
        const res = await RestAPI.post({
            url: `/quests/${quest.id}/heartbeat`,
            body: { stream_key: streamKey, terminal: false }
        });
        const progress = res.body.progress.PLAY_ACTIVITY.value;
        console.log(`[QuestNotifier] ${progress}/${secondsNeeded}`);
        if (progress >= secondsNeeded) {
            await RestAPI.post({
                url: `/quests/${quest.id}/heartbeat`,
                body: { stream_key: streamKey, terminal: true }
            });
            break;
        }
        await sleep(bell(20000, 1200));
    }

    console.log(`[QuestNotifier] Done: ${quest.config?.messages?.questName}`);
}

async function completeQuest(quest: Quest) {
    console.log(`[QuestNotifier] completeQuest: ${quest.config?.messages?.questName}`);
    const pid = (Math.floor(Math.random() * 16000) + 250) * 4;
    const applicationId = quest.config!.application!.id;
    const taskConfig = quest.config!.taskConfig ?? quest.config!.taskConfigV2!;
    const taskName = supportedTasks.find(x => taskConfig.tasks![x] != null)!;
    if (!isTaskEnabled(taskName)) {
        console.log(`[QuestNotifier] Skipping ${quest.config?.messages?.questName} (${taskName} disabled in settings)`);
        return;
    }

    const secondsNeeded = taskConfig.tasks![taskName]!.target!;
    const secondsDone = quest.config!.configVersion === 1
        ? quest.userStatus!.streamProgressSeconds ?? 0
        : quest.userStatus!.progress?.[taskName]?.value ?? 0;

    console.log(`[QuestNotifier] completeQuest: dispatching ${quest.config?.messages?.questName} to ${taskName} handler (${secondsDone}/${secondsNeeded}s)`);

    if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
        await watchVideo(quest, secondsNeeded, secondsDone);
    } else if (taskName === "PLAY_ON_DESKTOP") {
        if (!isApp) { console.log("[QuestNotifier] Needs desktop app for PLAY_ON_DESKTOP"); return; }
        await playOnDesktop(quest, applicationId, secondsNeeded, secondsDone, pid);
    } else if (taskName === "STREAM_ON_DESKTOP") {
        if (!isApp) { console.log("[QuestNotifier] Needs desktop app for STREAM_ON_DESKTOP"); return; }
        await streamOnDesktop(quest, applicationId, secondsNeeded, pid);
    } else if (taskName === "PLAY_ACTIVITY") {
        await playActivity(quest, secondsNeeded);
    }
}

// ------------ Main processing loop ------------
async function processQueue() {
    console.log("[QuestNotifier] processQueue started.");
    let loggedIdle = false;
    while (!stopCompletions) {
        if (pending.length === 0) {
            if (!loggedIdle) {
                console.log("[QuestNotifier] processQueue: queue empty, waiting for quests...");
                loggedIdle = true;
            }
            await sleep(5000);
            continue;
        }
        loggedIdle = false;

        const quest = pending.shift()!;
        console.log(`[QuestNotifier] Starting: ${quest.config?.messages?.questName} (${pending.length} still queued)`);

        // Simulate navigating to the quest UI
        await sleep(bell(3200, 600));
        await completeQuest(quest);

        if (pending.length > 0) {
            const distracted = Math.random() < 0.30;
            const wait = distracted ? bell(100000, 22000) : bell(38000, 8000);
            console.log(`[QuestNotifier] Next quest in ${Math.round(wait / 1000)}s...`);
            await idleWait(wait);
        }
    }
    console.log("[QuestNotifier] processQueue stopped.");
}

function autoQuestCheck() {
    const all = [...QuestsStore!.quests.values()];
    console.log(`[QuestNotifier] autoQuestCheck: ${all.length} quest(s) in store.`, all);

    const eligible = all.filter(isEligibleForCompletion);
    console.log(`[QuestNotifier] autoQuestCheck: ${eligible.length} quest(s) eligible for the completion queue.`, eligible);

    enqueueEligible(eligible);
}

// ------------ Plugin definition ------------
export default definePlugin({
    name: "QuestNotifier",
    description: "Notifica e completa automaticamente as Discord Quests.",
    tags: ["Notifications"],
    authors: [Devs.trapstar],
    settings,

    start() {
        console.log("[QuestNotifier] start() called.");
        stopCompletions = false;

        (async () => {
            QuestsStore = await resolveQuestsStore();
            if (!QuestsStore) {
                console.error("[QuestNotifier] QuestsStore não encontrada após várias tentativas; plugin não iniciado.");
                return;
            }
            if (stopCompletions) {
                console.log("[QuestNotifier] start() aborted: plugin was stopped while resolving QuestsStore.");
                return;
            }

            await waitForQuestsLoaded(QuestsStore);
            if (stopCompletions) {
                console.log("[QuestNotifier] start() aborted: plugin was stopped while waiting for quests to load.");
                return;
            }

            seenIds = loadSeenIds();
            shouldBaseline = true;
            console.log(`[QuestNotifier] Loaded ${seenIds?.size ?? 0} previously seen quest id(s) from storage.`);

            // Notification side
            QuestsStore.addChangeListener(notificationCheck);
            notificationCheck();

            // Auto‑completion side: seed with already enrolled quests.
            // Further quests are picked up by watchNewQuestsLoop's periodic re-scan.
            autoQuestCheck();

            // Start the completion processor and the paced enrollment watcher
            processQueue();
            watchNewQuestsLoop();

            console.log("[QuestNotifier] start() finished — all loops running.");
        })();
    },

    stop() {
        console.log("[QuestNotifier] stop() called.");
        stopCompletions = true;
        QuestsStore?.removeChangeListener(notificationCheck);
    }
});
