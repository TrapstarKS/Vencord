/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildStore, Modal, openModal, RTCConnectionStore, showToast, Text, Toasts, useEffect, UserStore, useState } from "@webpack/common";

type EventType = "join" | "leave" | "move-in" | "move-out";

interface LogEntry {
    id: number;
    time: number;
    type: EventType;
    userId: string;
    userName: string;
    avatarUrl?: string;
    channelName: string;
    guildName?: string;
}

const settings = definePluginSettings({
    notifyJoins: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when someone joins your voice channel",
        default: true
    },
    notifyLeaves: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when someone leaves your voice channel",
        default: true
    },
    includeSelf: {
        type: OptionType.BOOLEAN,
        description: "Also log your own joins/leaves",
        default: false
    },
    maxEntries: {
        type: OptionType.SLIDER,
        description: "Maximum number of log entries to keep in history",
        markers: [50, 100, 200, 500, 1000],
        default: 200,
        stickToMarkers: true
    }
});

let log: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(l => l());
}

function pushEntry(entry: Omit<LogEntry, "id" | "time">) {
    log.unshift({ ...entry, id: nextId++, time: Date.now() });
    if (log.length > settings.store.maxEntries) log.length = settings.store.maxEntries;
    emit();
}

function describe(type: EventType) {
    switch (type) {
        case "join": return { text: "joined", cls: "vc-vcl-join" };
        case "leave": return { text: "left", cls: "vc-vcl-leave" };
        case "move-in": return { text: "moved in", cls: "vc-vcl-join" };
        case "move-out": return { text: "moved away", cls: "vc-vcl-leave" };
    }
}

function formatClock(time: number) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(time);
}

function handleUpdate(state: { userId: string; channelId?: string | null; oldChannelId?: string | null; }) {
    const watched = RTCConnectionStore.getChannelId();
    if (!watched) return;

    const currentUserId = UserStore.getCurrentUser()?.id;
    if (state.userId === currentUserId && !settings.store.includeSelf) return;

    const { channelId, oldChannelId } = state;
    const joined = channelId === watched && oldChannelId !== watched;
    const left = oldChannelId === watched && channelId !== watched;
    if (!joined && !left) return;

    // Ignore our own connection event that establishes the watched channel.
    if (state.userId === currentUserId && joined && !oldChannelId) return;

    const type: EventType = joined
        ? (oldChannelId ? "move-in" : "join")
        : (channelId ? "move-out" : "leave");

    const user = UserStore.getUser(state.userId) as any;
    const channel = ChannelStore.getChannel(watched);
    const guildName = channel?.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : undefined;

    pushEntry({
        type,
        userId: state.userId,
        userName: user?.globalName || user?.username || "Unknown user",
        avatarUrl: user?.getAvatarURL?.(undefined, 32, false),
        channelName: channel?.name ?? "voice channel",
        guildName
    });

    const { text } = describe(type);
    if ((type === "leave" || type === "move-out") && settings.store.notifyLeaves)
        showToast(`${user?.globalName || user?.username || "Someone"} ${text}`, Toasts.Type.MESSAGE);
    else if ((type === "join" || type === "move-in") && settings.store.notifyJoins)
        showToast(`${user?.globalName || user?.username || "Someone"} ${text}`, Toasts.Type.SUCCESS);
}

function LogModal({ modalProps }: { modalProps: any; }) {
    const [, setVersion] = useState(0);

    // Subscribe to log changes while the modal is open.
    useEffect(() => {
        const cb = () => setVersion(v => v + 1);
        listeners.add(cb);
        return () => void listeners.delete(cb);
    }, []);

    return (
        <Modal
            {...modalProps}
            title="Voice Channel Log"
            actions={[
                { text: "Close", variant: "primary", onClick: modalProps.onClose },
                { text: "Clear", variant: "secondary", disabled: log.length === 0, onClick: () => { log = []; emit(); } }
            ]}
        >
            <div className="vc-vcl-modal">
                {log.length === 0
                    ? <Text variant="text-md/normal" className="vc-vcl-empty">No voice activity recorded yet. Join a voice channel to start logging.</Text>
                    : (
                        <div className="vc-vcl-list">
                            {log.map(entry => {
                                const { text, cls } = describe(entry.type);
                                return (
                                    <div key={entry.id} className="vc-vcl-row">
                                        {entry.avatarUrl && <img className="vc-vcl-avatar" src={entry.avatarUrl} alt="" />}
                                        <div className="vc-vcl-info">
                                            <span className="vc-vcl-name">{entry.userName}</span>
                                            <span className={`vc-vcl-action ${cls}`}>{text}</span>
                                            <span className="vc-vcl-channel">{entry.channelName}{entry.guildName ? ` · ${entry.guildName}` : ""}</span>
                                        </div>
                                        <span className="vc-vcl-time">{formatClock(entry.time)}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
            </div>
        </Modal>
    );
}

function openLog() {
    openModal(modalProps => <LogModal modalProps={modalProps} />);
}

export default definePlugin({
    name: "VoiceChannelLog",
    description: "Keeps a live log of who joins, leaves and moves in the voice channel you're connected to, with optional toasts and a history viewer (Vencord toolbox).",
    authors: [Devs.trapstar],
    tags: ["Voice", "Utility"],
    searchTerms: ["log", "join", "leave", "tracker"],
    settings,

    toolboxActions: {
        "Open Voice Channel Log": openLog
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; oldChannelId?: string | null; }>; }) {
            for (const state of voiceStates) handleUpdate(state);
        }
    },

    stop() {
        log = [];
        listeners.clear();
    }
});
