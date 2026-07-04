/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, ChannelStore, GuildStore, PresenceStore, RelationshipStore, UserStore, VoiceStateStore } from "@webpack/common";

const logger = new Logger("BetterActiveNow");

const settings = definePluginSettings({
    onlyCalls: {
        type: OptionType.BOOLEAN,
        description: "Show only voice calls in Active Now (hide activity-only entries such as games / streams / Spotify)",
        default: false,
        restartNeeded: true
    },
    callsFirst: {
        type: OptionType.BOOLEAN,
        description: "Sort voice calls to the top of the Active Now list",
        default: true,
        restartNeeded: true
    },
    hideImplicit: {
        type: OptionType.BOOLEAN,
        // Off by default: implicit relationships (people you aren't actually friends with) stay visible unless enabled.
        description: "Hide people you're not actually friends with (implicit relationships) from Active Now",
        default: false,
        restartNeeded: true
    },
    confirmBeforeJoin: {
        type: OptionType.BOOLEAN,
        description: "Ask for confirmation before joining a call from Active Now (instead of joining instantly)",
        default: true
    },
    reliableCalls: {
        type: OptionType.BOOLEAN,
        // Discord's own NowPlayingViewStore intermittently misses friends' voice calls (limited guild scan + throttling),
        // even though VoiceStateStore has the data. We re-derive missing calls from VoiceStateStore so they always show.
        // Off by default: the synthetic card built below doesn't fully match the shape Discord's own
        // card renderer expects, and can crash it (Cannot read properties of null (reading 'id') in
        // VoiceSection) right after login, before NowPlayingViewStore has caught up.
        description: "Reliably show friends' voice calls (fixes Discord sometimes not detecting them) — experimental, can cause a crash on login",
        default: false,
        restartNeeded: true
    }
});

// An Active Now entry is `{ type, party }`; `party.voiceChannels` is non-empty exactly when it's a voice call.
const isCall = (card: any) => (card?.party?.voiceChannels?.length ?? 0) > 0;

function memberIds(party: any): string[] {
    const ids = new Set<string>();
    for (const u of party?.partiedMembers ?? []) if (u?.id) ids.add(u.id);
    for (const m of party?.priorityMembers ?? []) if (m?.user?.id) ids.add(m.user.id);
    for (const vc of party?.voiceChannels ?? []) for (const u of vc?.members ?? []) if (u?.id) ids.add(u.id);
    return [...ids];
}

// Keep the card if at least one of its members is an actual friend.
const isFriendCard = (card: any) => memberIds(card?.party).some(id => RelationshipStore.isFriend(id));

// Channel types that belong in Active Now: guild voice (2) and group DM (3). Private 1:1 DM calls (1) are your own.
const VOICE_CHANNEL_TYPES = new Set([2, 3]);

/**
 * Re-derive friends' voice calls straight from VoiceStateStore and return card objects for any the given
 * cards don't already cover. This closes the gap where Discord's NowPlayingViewStore intermittently drops
 * calls it actually has the data for. The synthetic cards match the store's `{ type, party }` shape so the
 * normal Active Now card component renders them identically.
 */
function buildMissingCallCards(existingCards: any[]): any[] {
    const out: any[] = [];
    try {
        const covered = new Set<string>();
        for (const c of existingCards) for (const vc of c?.party?.voiceChannels ?? []) if (vc?.channel?.id) covered.add(vc.channel.id);

        // group the friends we find in voice by their channel
        const byChannel = new Map<string, { channel: any; friendIds: Set<string>; }>();
        for (const id of RelationshipStore.getFriendIDs()) {
            const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId;
            if (!channelId || covered.has(channelId)) continue;
            const channel = ChannelStore.getChannel(channelId);
            if (!channel || !VOICE_CHANNEL_TYPES.has(channel.type)) continue;
            let entry = byChannel.get(channelId);
            if (!entry) byChannel.set(channelId, entry = { channel, friendIds: new Set() });
            entry.friendIds.add(id);
        }

        for (const [channelId, { channel, friendIds }] of byChannel) {
            const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
            // union of everyone the channel voice states list + the friends we detected (in case the channel list is sparse)
            const memberIdSet = new Set<string>([...Object.keys(voiceStates), ...friendIds]);
            const members = [...memberIdSet].map(uid => UserStore.getUser(uid)).filter(Boolean);
            if (!members.length) continue;

            const guildId = channel.getGuildId?.() ?? null;
            const guild = guildId ? GuildStore.getGuild(guildId) : null;

            out.push({
                type: "user",
                party: {
                    id: "channel-" + channelId,
                    voiceChannels: [{ channel, guild, members, voiceStates }],
                    isSpotifyActivity: false,
                    priorityMembers: members.map((u: any) => ({ user: u, status: PresenceStore.getStatus(u.id) })),
                    partiedMembers: members,
                    showPlayingMembers: false,
                    guildContext: guild,
                    currentActivities: [],
                    applicationStreams: []
                }
            });
        }
    } catch (e) {
        logger.error("buildMissingCallCards failed", e);
    }
    return out;
}

export default definePlugin({
    name: "BetterActiveNow",
    description: "Tweaks the Active Now panel: show only calls, sort calls to the top, hide non-friends, and confirm before joining a call.",
    tags: ["Friends", "Voice", "Activity"],
    authors: [Devs.trapstar],
    settings,

    patches: [
        // (A) Filter + sort the Active Now card list at its single source: NowPlayingViewStore.nowPlayingCards.
        {
            find: '"NowPlayingViewStore"',
            replacement: {
                match: /get nowPlayingCards\(\)\{return (\i)\}/,
                replace: "get nowPlayingCards(){return $self.processCards($1)}"
            },
            predicate: () => settings.store.onlyCalls || settings.store.callsFirst || settings.store.hideImplicit
        },
        // (B) Confirm before joining when clicking a voice-channel row in an Active Now card.
        // The card's onClick does `selectVoiceChannel(n.id),(0,x.y)(n.id)`; we wrap that in a confirmation.
        {
            find: "in_voice_channel:",
            replacement: {
                match: /(\i\.default\.selectVoiceChannel\((\i)\.id\),\(0,\i\.\i\)\(\i\.id\))/,
                replace: "$self.confirmJoin($2?.id,()=>{$1})"
            },
            predicate: () => settings.store.confirmBeforeJoin
        }
    ],

    /** Augment (reliable calls) + filter/sort the `[{ type, party }]` card array. Called from patch (A). */
    processCards(cards: any[]) {
        try {
            if (!Array.isArray(cards)) return cards;

            const { onlyCalls, hideImplicit, callsFirst, reliableCalls } = settings.store;

            let result = cards;

            // Prepend any friend calls Discord's store missed, so calls show reliably.
            if (reliableCalls) {
                const missing = buildMissingCallCards(cards);
                if (missing.length) result = [...missing, ...cards];
            }

            if (result === cards && !onlyCalls && !hideImplicit && !callsFirst) return cards;

            if (onlyCalls) result = result.filter(isCall);
            if (hideImplicit) result = result.filter(isFriendCard);
            if (callsFirst) {
                // Stable: calls float up, everything else keeps Discord's own scored order.
                result = (result === cards ? [...result] : result).sort((a, b) => Number(isCall(b)) - Number(isCall(a)));
            }
            return result;
        } catch (e) {
            logger.error("processCards failed; returning cards unchanged", e);
            return cards;
        }
    },

    /** Prompt before joining a call; if confirmed (or disabled), run the original join. Called from patch (B). */
    confirmJoin(channelId: string | undefined, join: () => void) {
        if (!settings.store.confirmBeforeJoin) return join();

        let body = "Você vai entrar nesta chamada.";
        try {
            const channel = channelId != null ? ChannelStore.getChannel(channelId) : undefined;
            const names = channelId != null
                ? Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})
                    .map((s: any) => UserStore.getUser(s.userId)?.username)
                    .filter(Boolean)
                    .slice(0, 5)
                : [];
            const where = channel?.name ? `em ${channel.name}` : "nesta chamada";
            body = names.length ? `Você vai entrar ${where} com ${names.join(", ")}.` : `Você vai entrar ${where}.`;
        } catch { /* keep the generic message */ }

        Alerts.show({
            title: "Entrar na call?",
            body,
            confirmText: "Entrar",
            cancelText: "Cancelar",
            onConfirm: () => {
                try {
                    join();
                } catch (e) {
                    logger.error("join failed", e);
                }
            }
        });
    }
});
