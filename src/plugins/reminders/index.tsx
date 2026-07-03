/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Modal, openModal, Text, useEffect, useState } from "@webpack/common";

interface Reminder {
    id: string;
    text: string;
    dueAt: number;
    createdAt: number;
    channelId?: string;
}

const KEY = "Reminders:v1";
const MAX_TIMEOUT = 2 ** 31 - 1;

const settings = definePluginSettings({
    permanentNotifications: {
        type: OptionType.BOOLEAN,
        description: "Keep reminder notifications on screen until you dismiss them",
        default: true
    }
});

let reminders: Reminder[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());
const persist = () => DataStore.set(KEY, reminders);

function genId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseDuration(input: string): number | null {
    const re = /(\d+)\s*(d|h|m|s)/gi;
    let ms = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input))) {
        matched = true;
        const n = Number(m[1]);
        switch (m[2].toLowerCase()) {
            case "d": ms += n * 86_400_000; break;
            case "h": ms += n * 3_600_000; break;
            case "m": ms += n * 60_000; break;
            case "s": ms += n * 1_000; break;
        }
    }
    return matched && ms > 0 ? ms : null;
}

function relative(dueAt: number): string {
    const diff = dueAt - Date.now();
    if (diff <= 0) return "now";
    const s = Math.round(diff / 1000);
    if (s < 60) return `in ${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
    const d = Math.floor(h / 24);
    return `in ${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

function fire(reminder: Reminder) {
    timers.delete(reminder.id);
    const stillPending = reminders.some(r => r.id === reminder.id);
    if (!stillPending) return;

    reminders = reminders.filter(r => r.id !== reminder.id);
    persist();
    emit();

    showNotification({
        title: "⏰ Reminder",
        body: reminder.text,
        permanent: settings.store.permanentNotifications
    });
}

function schedule(reminder: Reminder) {
    clearTimeout(timers.get(reminder.id));
    const delay = reminder.dueAt - Date.now();
    if (delay <= 0) {
        fire(reminder);
        return;
    }
    const timer = setTimeout(() => {
        // Re-check in case the delay was clamped for very distant reminders.
        if (Date.now() >= reminder.dueAt) fire(reminder);
        else schedule(reminder);
    }, Math.min(delay, MAX_TIMEOUT));
    timers.set(reminder.id, timer);
}

function cancel(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    reminders = reminders.filter(r => r.id !== id);
    persist();
    emit();
}

function ManagerModal({ modalProps }: { modalProps: any; }) {
    const [, setVersion] = useState(0);

    useEffect(() => {
        const cb = () => setVersion(v => v + 1);
        listeners.add(cb);
        const interval = setInterval(cb, 1000);
        return () => {
            listeners.delete(cb);
            clearInterval(interval);
        };
    }, []);

    const sorted = [...reminders].sort((a, b) => a.dueAt - b.dueAt);

    return (
        <Modal
            {...modalProps}
            title="Your Reminders"
            actions={[{ text: "Close", variant: "primary", onClick: modalProps.onClose }]}
        >
            <div className="vc-rem-modal">
                {sorted.length === 0
                    ? <Text variant="text-md/normal" className="vc-rem-empty">No reminders yet. Set one with <code>/remind</code>.</Text>
                    : (
                        <div className="vc-rem-list">
                            {sorted.map(r => (
                                <div key={r.id} className="vc-rem-row">
                                    <div className="vc-rem-info">
                                        <span className="vc-rem-text">{r.text}</span>
                                        <span className="vc-rem-due">{relative(r.dueAt)} · {new Date(r.dueAt).toLocaleString()}</span>
                                    </div>
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        color={Button.Colors.RED}
                                        look={Button.Looks.FILLED}
                                        onClick={() => cancel(r.id)}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
            </div>
        </Modal>
    );
}

const openManager = () => openModal(modalProps => <ManagerModal modalProps={modalProps} />);

export default definePlugin({
    name: "Reminders",
    description: "Set personal, time-based reminders with /remind (e.g. /remind 2h30m \"call mom\"). Reminders persist locally and fire a notification when due; manage them with /reminders.",
    authors: [Devs.trapstar],
    tags: ["Utility", "Notifications", "Commands"],
    searchTerms: ["reminder", "remind", "todo", "alarm", "notification"],
    settings,

    commands: [
        {
            name: "remind",
            description: "Set a personal reminder",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "duration",
                    description: "When to remind you — e.g. 10m, 2h30m, 1d",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "message",
                    description: "What to remind you about",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute(args, ctx) {
                const durationStr = findOption(args, "duration", "");
                const text = findOption(args, "message", "");
                const ms = parseDuration(durationStr);

                if (!ms) {
                    sendBotMessage(ctx.channel.id, {
                        content: "⚠️ I couldn't understand that duration. Try something like `10m`, `2h30m` or `1d`."
                    });
                    return;
                }

                const reminder: Reminder = {
                    id: genId(),
                    text,
                    dueAt: Date.now() + ms,
                    createdAt: Date.now(),
                    channelId: ctx.channel.id
                };

                reminders.push(reminder);
                persist();
                schedule(reminder);
                emit();

                sendBotMessage(ctx.channel.id, {
                    content: `⏰ Okay! I'll remind you <t:${Math.floor(reminder.dueAt / 1000)}:R> — **${text}**`
                });
            }
        },
        {
            name: "reminders",
            description: "View and manage your pending reminders",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute() {
                openManager();
            }
        }
    ],

    async start() {
        reminders = (await DataStore.get<Reminder[]>(KEY)) ?? [];
        for (const reminder of reminders) schedule(reminder);
    },

    stop() {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        listeners.clear();
    }
});
