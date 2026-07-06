/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RelationshipType } from "@vencord/discord-types/enums";
import { findStoreLazy } from "@webpack";
import { Alerts, ChannelStore, GuildStore, PresenceStore, RelationshipStore, UserAffinitiesStore, UserStore, VoiceStateStore } from "@webpack/common";

const logger = new Logger("BetterActiveNow");
const NowPlayingViewStore = findStoreLazy("NowPlayingViewStore");

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
    sortByRelationship: {
        type: OptionType.BOOLEAN,
        description: "Sort Active Now with friends first, then implicit relationships (highest affinity first)",
        default: true,
        restartNeeded: true
    },
    minImplicitAffinity: {
        type: OptionType.NUMBER,
        description: "Minimum affinity (0 to 1) an implicit relationship needs to appear in Active Now at all",
        default: 0.002,
        restartNeeded: false
    },
    confirmBeforeJoin: {
        type: OptionType.BOOLEAN,
        description: "Ask for confirmation before joining a call from Active Now (instead of joining instantly)",
        default: true
    },
    reliableCalls: {
        type: OptionType.BOOLEAN,
        // Discord's own NowPlayingViewStore intermittently misses friends'/implicit relationships' voice calls
        // (limited guild scan + throttling), even though VoiceStateStore has the data. We re-derive missing
        // calls from VoiceStateStore so they always show. Previously this crashed VoiceSection (null `.id`
        // read) because it also synthesized cards for group DM calls, which have no guild, and set
        // guildContext to null unconditionally — see buildMissingCallCards. Now restricted to guild voice
        // channels with a resolvable guild, so that never happens.
        description: "Reliably show friends'/implicit relationships' voice calls (fixes Discord sometimes not detecting them)",
        default: false,
        restartNeeded: true
    },
    showRelationshipBadge: {
        type: OptionType.BOOLEAN,
        description: "In the member list popout (click a call's avatar stack in Active Now), tag each friend/implicit relationship so it's obvious why that call showed up",
        default: true,
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

// A bot can end up with an IMPLICIT relationship entry (ImplicitRelationships derives it purely from
// UserAffinitiesStore affinity, which doesn't know or care whether the other party is a bot) and most
// "implicit" affinities are noise from one-off server overlap rather than an actual relationship — so
// anywhere this plugin treats a user as implicit, it must go through here: not a bot, and above the
// configured affinity floor.
function isTrackedImplicit(id: string): boolean {
    if (RelationshipStore.getRelationshipType(id) !== RelationshipType.IMPLICIT) return false;
    if (UserStore.getUser(id)?.bot) return false;
    return (UserAffinitiesStore.getUserAffinity(id)?.communicationProbability ?? 0) >= settings.store.minImplicitAffinity;
}

const implicitAffinity = (id: string) => UserAffinitiesStore.getUserAffinity(id)?.communicationProbability ?? 0;

// 2 = has an actual friend, 1 = has a tracked implicit relationship, 0 = neither. Used to sort friends
// before implicit relationships in the Active Now list.
function cardRelationshipTier(card: any): number {
    const ids = memberIds(card?.party);
    if (ids.some(id => RelationshipStore.isFriend(id))) return 2;
    if (ids.some(isTrackedImplicit)) return 1;
    return 0;
}

// Combined affinity across all of the card's tracked-implicit members (0 if it has none) — a call with
// several implicit relationships in it ranks higher than any one of them alone. Orders implicit-tier cards
// among themselves, highest combined affinity first.
function cardImplicitAffinity(card: any): number {
    let total = 0;
    for (const id of memberIds(card?.party)) {
        if (isTrackedImplicit(id)) total += implicitAffinity(id);
    }
    return total;
}

// Only guild voice channels (2). Discord's own gap is specifically a "limited guild scan" (see comment
// on the setting above), so that's the only case worth re-deriving. Group DM calls (3) were included here
// before, but a group DM channel has no guild by definition — every synthetic card for one carried
// `guildContext: null`, and Discord's real Active Now card renderer expects `guildContext` to always be a
// real guild for a rendered voice row. That's the null `.id` read that crashed VoiceSection, and it wasn't
// a rare race: it fired on every group DM call, deterministically.
const VOICE_CHANNEL_TYPES = new Set([2]);

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

        // Friends and implicit relationships (people you have affinity for but aren't friends with, see
        // ImplicitRelationships) are both candidates: Discord's own "limited guild scan" gap that this
        // feature works around isn't friend-specific, so restricting the scan to literal friends only
        // meant an implicit-only call was never re-derived even though this is exactly the case it's for.
        const trackedIds = new Set(RelationshipStore.getFriendIDs());
        for (const [id] of RelationshipStore.getMutableRelationships()) {
            if (isTrackedImplicit(id)) trackedIds.add(id);
        }

        // group the tracked users we find in voice by their channel
        const byChannel = new Map<string, { channel: any; trackedMemberIds: Set<string>; }>();
        for (const id of trackedIds) {
            const channelId = VoiceStateStore.getVoiceStateForUser(id)?.channelId;
            if (!channelId || covered.has(channelId)) continue;
            const channel = ChannelStore.getChannel(channelId);
            if (!channel || !VOICE_CHANNEL_TYPES.has(channel.type)) continue;
            let entry = byChannel.get(channelId);
            if (!entry) byChannel.set(channelId, entry = { channel, trackedMemberIds: new Set() });
            entry.trackedMemberIds.add(id);
        }

        for (const [channelId, { channel, trackedMemberIds }] of byChannel) {
            const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
            // union of everyone the channel voice states list + the tracked users we detected (in case the channel list is sparse)
            const memberIdSet = new Set<string>([...Object.keys(voiceStates), ...trackedMemberIds]);
            // Require a resolved `.id`, not just a truthy value: UserStore can hand back a partial/stub
            // record mid-hydration that lacks it, and that's the same class of null-read crash this
            // function has already been bitten by once (see guildContext below).
            const members = [...memberIdSet].map(uid => UserStore.getUser(uid)).filter((u: any) => u?.id);
            if (!members.length) continue;

            // Prefer the raw `guild_id` field over the `getGuildId()` method: early in boot (right after
            // CONNECTION_OPEN, before stores fully hydrate) ChannelStore can hand back a channel record whose
            // prototype methods aren't wired up yet, silently making `getGuildId?.()` resolve to undefined
            // even for a real guild channel. `guild_id` is a plain data property and survives that.
            const guildId = channel.guild_id ?? channel.getGuildId?.() ?? null;
            const guild = guildId ? GuildStore.getGuild(guildId) : null;
            // No guild resolved for a guild voice channel (store not hydrated yet, or bad data) — skip
            // rather than emit a card with a null guildContext, which is exactly what crashed VoiceSection.
            if (!guild) continue;

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

    // Patch (A) only changes what the nowPlayingCards getter *returns*; Discord's own store still decides
    // *when* to recompute it (gated by its own scan/throttle behavior). So a friend/implicit joining a call
    // can sit correctly-derivable-but-unread until something else happens to trigger a re-render. Forcing
    // emitChange ourselves on the relevant voice-state change makes the panel pick it up immediately instead
    // of waiting on Discord's internal timing.
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; oldChannelId?: string | null; }>; }) {
            const { onlyCalls, callsFirst, hideImplicit, reliableCalls, sortByRelationship } = settings.store;
            if (!onlyCalls && !callsFirst && !hideImplicit && !reliableCalls && !sortByRelationship) return;

            const relevant = voiceStates.some(vs => vs.userId && (RelationshipStore.isFriend(vs.userId) || isTrackedImplicit(vs.userId)));
            if (relevant) NowPlayingViewStore.emitChange();
        }
    },

    patches: [
        // (A) Filter + sort the Active Now card list at its single source: NowPlayingViewStore.nowPlayingCards.
        {
            find: '"NowPlayingViewStore"',
            replacement: {
                match: /get nowPlayingCards\(\)\{return (\i)\}/,
                replace: "get nowPlayingCards(){return $self.processCards($1)}"
            },
            predicate: () => settings.store.onlyCalls || settings.store.callsFirst || settings.store.hideImplicit || settings.store.reliableCalls || settings.store.sortByRelationship
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
        },
        // (C) Tag each row in the "who's in this call" popout (navId "now-playing-menu", opened by clicking
        // a card's avatar stack in Active Now) with the member's relationship to you. That popout renders
        // every member (priority + other) through one shared row component ending in the username element
        // `(0,x.jsx)(y.A,{user:z,hideDiscriminator:!0})`; we splice our own badge element in right after it.
        {
            find: '"now-playing-menu"',
            replacement: {
                match: /(\(0,\i\.jsx\)\(\i\.A,\{user:(\i),hideDiscriminator:!0\}\))\]/,
                replace: "$1,$self.renderRelationshipBadge($2)]"
            },
            predicate: () => settings.store.showRelationshipBadge
        }
    ],

    /** Augment (reliable calls) + filter/sort the `[{ type, party }]` card array. Called from patch (A). */
    processCards(cards: any[]) {
        try {
            if (!Array.isArray(cards)) return cards;

            const { onlyCalls, hideImplicit, callsFirst, reliableCalls, sortByRelationship } = settings.store;

            let result = cards;

            // Prepend any friend calls Discord's store missed, so calls show reliably.
            if (reliableCalls) {
                const missing = buildMissingCallCards(cards);
                if (missing.length) result = [...missing, ...cards];
            }

            if (result === cards && !onlyCalls && !hideImplicit && !callsFirst && !sortByRelationship) return cards;

            if (onlyCalls) result = result.filter(isCall);
            if (hideImplicit) result = result.filter(isFriendCard);
            if (callsFirst || sortByRelationship) {
                // Stable: calls float up (if callsFirst), then friends before implicit relationships before
                // everyone else (if sortByRelationship), then implicit relationships among themselves by
                // highest affinity first. Anything not covered by an active criterion keeps Discord's own
                // relative order.
                result = (result === cards ? [...result] : result).sort((a, b) => {
                    if (callsFirst) {
                        const callDiff = Number(isCall(b)) - Number(isCall(a));
                        if (callDiff !== 0) return callDiff;
                    }
                    if (sortByRelationship) {
                        const tierDiff = cardRelationshipTier(b) - cardRelationshipTier(a);
                        if (tierDiff !== 0) return tierDiff;
                        return cardImplicitAffinity(b) - cardImplicitAffinity(a);
                    }
                    return 0;
                });
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
    },

    /** Badge shown next to a member's name in the call's member-list popout. Called from patch (C). */
    renderRelationshipBadge(user: any) {
        try {
            const id = user?.id;
            if (!id) return null;
            if (RelationshipStore.isFriend(id)) {
                return <span style={{ opacity: 0.6, fontSize: 12, marginLeft: 6 }}>Amigo</span>;
            }
            if (isTrackedImplicit(id)) {
                return <span style={{ opacity: 0.6, fontSize: 12, marginLeft: 6 }}>{(implicitAffinity(id) * 100).toFixed(2)}% afinidade</span>;
            }
            return null;
        } catch (e) {
            logger.error("renderRelationshipBadge failed", e);
            return null;
        }
    }
});
