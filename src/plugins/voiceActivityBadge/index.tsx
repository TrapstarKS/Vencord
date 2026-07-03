/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { openUserProfile } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { Alerts, ChannelRouter, ChannelRTCStore, ChannelStore, Parser, PermissionsBits, PermissionStore, Popout, showToast, Text, Toasts, useMemo, useRef, UserStore, useState, useStateFromStores, VoiceStateStore } from "@webpack/common";
import type { MouseEvent } from "react";

const { selectVoiceChannel } = findByPropsLazy("selectVoiceChannel", "selectChannel");

const CLICK_DELAY = 220;

const settings = definePluginSettings({
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show the badge in the member/DM list",
        default: true
    },
    showInProfile: {
        type: OptionType.BOOLEAN,
        description: "Show the badge in user profiles",
        default: true
    },
    showStreaming: {
        type: OptionType.BOOLEAN,
        description: "Show when a user is streaming / screen-sharing",
        default: true
    },
    showVideo: {
        type: OptionType.BOOLEAN,
        description: "Show when a user has their camera on",
        default: true
    },
    showDeafened: {
        type: OptionType.BOOLEAN,
        description: "Show when a user is deafened",
        default: true
    },
    showMuted: {
        type: OptionType.BOOLEAN,
        description: "Show when a user is muted",
        default: true
    },
    showSpeaking: {
        type: OptionType.BOOLEAN,
        description: "Highlight when a user is currently speaking (only for your current call)",
        default: true
    },
    showConnected: {
        type: OptionType.BOOLEAN,
        description: "Show a plain icon when a user is simply connected to voice",
        default: true
    }
});

type Glyph = "stream" | "video" | "deaf" | "muted" | "speaking" | "connected";

// Discord's own filled voice icons (fill="currentColor"), so the badge matches native UI.
// Path data only — building JSX at module load runs createElement before webpack is ready.
const ICON_PATHS: Record<Glyph, string[]> = {
    connected: [
        "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z",
        "M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z"
    ],
    speaking: [
        "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z",
        "M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z"
    ],
    muted: [
        "m2.7 22.7 20-20a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4ZM10.8 17.32c-.21.21-.1.58.2.62V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 10a1 1 0 0 0-2 0c0 1.45-.52 2.79-1.38 3.83l-.02.02A5.99 5.99 0 0 1 12.32 16a.52.52 0 0 0-.34.15l-1.18 1.18ZM15.36 4.52c.15-.15.19-.38.08-.56A4 4 0 0 0 8 6v4c0 .3.03.58.1.86.07.34.49.43.74.18l6.52-6.52ZM5.06 13.98c.16.28.53.31.75.09l.75-.75c.16-.16.19-.4.08-.61A5.97 5.97 0 0 1 6 10a1 1 0 0 0-2 0c0 1.45.39 2.81 1.06 3.98Z"
    ],
    deaf: [
        "M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4l20-20ZM17.06 2.94a.48.48 0 0 0-.11-.77A11 11 0 0 0 2.18 16.94c.14.3.53.35.76.12l3.2-3.2c.25-.25.15-.68-.2-.76a5 5 0 0 0-1.02-.1H3.05a9 9 0 0 1 12.66-9.2c.2.09.44.05.59-.1l.76-.76ZM20.2 8.28a.52.52 0 0 1 .1-.58l.76-.76a.48.48 0 0 1 .77.11 11 11 0 0 1-4.5 14.57c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86a9.1 9.1 0 0 0-.75-4.72ZM10.1 17.9c.25-.25.65-.18.74.14a3.1 3.1 0 0 1-.62 2.84 2.85 2.85 0 0 1-3.55.74.16.16 0 0 1-.04-.25l3.48-3.48Z"
    ],
    video: [
        "M4 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2.13l3.2 2.4A1 1 0 0 0 23 16.5v-9a1 1 0 0 0-1.6-.8L17 9.13V7a3 3 0 0 0-3-3H4Z"
    ],
    stream: [
        "M2 4.5A2.5 2.5 0 0 1 4.5 2h15A2.5 2.5 0 0 1 22 4.5v11a2.5 2.5 0 0 1-2.5 2.5H14v2h2a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h2v-2H4.5A2.5 2.5 0 0 1 2 15.5v-11Zm10.7 2.8a1 1 0 0 0-1.4 0l-3 3a1 1 0 0 0 1.4 1.4l1.3-1.29V14a1 1 0 1 0 2 0v-3.59l1.3 1.3a1 1 0 0 0 1.4-1.42l-3-3Z"
    ]
};

const MAX_AVATARS = 12;

// DM/group channels have an empty `name`; fall back to the recipients so the card isn't blank.
function channelLabel(channel: Channel): string {
    if (channel.name) return channel.name;
    const names = (channel.recipients ?? [])
        .map(id => {
            const u = UserStore.getUser(id);
            return u?.globalName ?? u?.username;
        })
        .filter(Boolean);
    return names.length ? names.join(", ") : "Chamada";
}

function GlyphSvg({ glyph, size }: { glyph: Glyph; size: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {ICON_PATHS[glyph].map((d, i) => <path key={i} d={d} />)}
        </svg>
    );
}

// A single click on a channel/badge should not also trigger the double-click action, so single
// actions are deferred by CLICK_DELAY and cancelled when a double click arrives.
function useDeferredClick() {
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    return (e: MouseEvent, onSingle: () => void, onDouble: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(timer.current);
        if (e.detail > 1) onDouble();
        else timer.current = setTimeout(onSingle, CLICK_DELAY);
    };
}

// The pinned card shown when you click the badge. Lives in a Popout so it stays put and is
// fully interactive: click the channel to go there / double click to join, click a member to
// open their profile.
function VoiceCard({ channel }: { channel: Channel; }) {
    const voiceStates = useStateFromStores([VoiceStateStore], () => VoiceStateStore.getVoiceStatesForChannel(channel.id));
    const users = useMemo(
        () => Object.values(voiceStates).map(vs => UserStore.getUser(vs.userId)).filter(user => user != null),
        [voiceStates]
    );
    const handleClick = useDeferredClick();

    const isDM = !!(channel.isDM?.() || channel.isMultiUserDM?.());

    const goToChannel = () => ChannelRouter.transitionToChannel(channel.id);
    const joinChannel = () => {
        if (!isDM && !PermissionStore.can(PermissionsBits.CONNECT, channel)) {
            showToast("You cannot join this voice channel", Toasts.Type.FAILURE);
            return;
        }
        Alerts.show({
            title: "Entrar na call?",
            body: `Você vai entrar em ${channelLabel(channel)}.`,
            confirmText: "Entrar",
            cancelText: "Cancelar",
            onConfirm: () => selectVoiceChannel(channel.id)
        });
    };

    const shownUsers = users.slice(0, MAX_AVATARS);
    const overflow = users.length - shownUsers.length;

    // Mirrors UserVoiceShow's tooltip layout: "In Voice Chat", the channel mention, then a
    // speaker icon + avatar stack. The channel row and avatars carry our own click mechanics.
    return (
        <div className="vc-vab-card">
            <Text variant="text-sm/bold">In Voice Chat</Text>

            <div
                className="vc-vab-card-channel"
                role="button"
                onClick={e => handleClick(e, goToChannel, joinChannel)}
            >
                <Text variant="text-sm/bold">
                    {channel.guild_id ? Parser.parse(`<#${channel.id}>`) : channelLabel(channel)}
                </Text>
            </div>

            {shownUsers.length > 0 && (
                <div className="vc-vab-card-members">
                    <GlyphSvg glyph="connected" size={18} />
                    <div className="vc-vab-card-avatars">
                        {shownUsers.map(user => (
                            <img
                                key={user.id}
                                className="vc-vab-card-avatar"
                                src={user.getAvatarURL(channel.guild_id, 64)}
                                alt=""
                                title={user.globalName ?? user.username}
                                onClick={() => { openUserProfile(user.id); }}
                            />
                        ))}
                    </div>
                    {overflow > 0 && <span className="vc-vab-card-more">+{overflow}</span>}
                </div>
            )}
        </div>
    );
}

function VoiceActivityBadge({ userId, location }: { userId: string; location: "list" | "profile"; }) {
    const voiceState = useStateFromStores([VoiceStateStore], () => VoiceStateStore.getVoiceStateForUser(userId));
    const channelId = voiceState?.channelId;

    const isSpeaking = useStateFromStores([ChannelRTCStore], () => {
        if (!channelId) return false;
        try {
            return !!(ChannelRTCStore.getParticipants(channelId) as any[])?.find(p => p?.id === userId)?.speaking;
        } catch {
            return false;
        }
    });

    const badgeRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const handleClick = useDeferredClick();

    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    if (!channelId || !channel) return null;

    const muted = voiceState!.mute || voiceState!.selfMute;
    const deaf = voiceState!.deaf || voiceState!.selfDeaf;
    const video = voiceState!.selfVideo;
    const stream = (voiceState as any)!.selfStream || voiceState!.stream;

    let glyph: Glyph | null = null;
    if (stream && settings.store.showStreaming) glyph = "stream";
    else if (video && settings.store.showVideo) glyph = "video";
    else if (deaf && settings.store.showDeafened) glyph = "deaf";
    else if (muted && settings.store.showMuted) glyph = "muted";
    else if (isSpeaking && settings.store.showSpeaking) glyph = "speaking";
    else if (settings.store.showConnected) glyph = "connected";

    if (!glyph) return null;
    const g = glyph;
    const active = g === "speaking";

    // Single click → toggle the card open (it stays until you click away). Double click → go to the channel.
    const onBadgeClick = (e: MouseEvent) => handleClick(
        e,
        () => setOpen(o => !o),
        () => { setOpen(false); ChannelRouter.transitionToChannel(channelId); }
    );

    return (
        <Popout
            targetElementRef={badgeRef}
            shouldShow={open}
            onRequestClose={() => setOpen(false)}
            position="top"
            align="center"
            animation={Popout.Animation.FADE}
            spacing={8}
            autoInvert
            nudgeAlignIntoViewport
            renderPopout={() => <VoiceCard channel={channel!} />}
        >
            {() => (
                <span
                    ref={badgeRef}
                    role="button"
                    onClick={onBadgeClick}
                    className={`vc-vab-badge vc-vab-${g} vc-vab-${location} ${active ? "vc-vab-active" : ""}`}
                >
                    <GlyphSvg glyph={g} size={14} />
                </span>
            )}
        </Popout>
    );
}

const profileBadge: ProfileBadge = {
    id: "vc-voice-activity-badge",
    position: BadgePosition.START,
    getBadges({ userId }) {
        if (!settings.store.showInProfile || !userId) return [];
        if (!VoiceStateStore.getVoiceStateForUser(userId)?.channelId) return [];
        return [{
            id: "vc-voice-activity-badge-inner",
            component: () => <VoiceActivityBadge userId={userId} location="profile" />
        }];
    }
};

export default definePlugin({
    name: "VoiceActivityBadge",
    description: "Shows a live glyph on user avatars (member list & profiles) reflecting their voice state — muted, deafened, camera, streaming or speaking. Click it for a card listing who's in the channel; double click to jump there.",
    authors: [Devs.trapstar],
    tags: ["Voice", "Activity"],
    searchTerms: ["indicator", "badge", "mute", "speaking", "stream"],
    settings,

    start() {
        addMemberListDecorator("vc-voice-activity-badge", ({ user }) => {
            if (!settings.store.showInMemberList || !user) return null;
            return <VoiceActivityBadge userId={user.id} location="list" />;
        });
        addProfileBadge(profileBadge);
    },

    stop() {
        removeMemberListDecorator("vc-voice-activity-badge");
        removeProfileBadge(profileBadge);
    }
});
