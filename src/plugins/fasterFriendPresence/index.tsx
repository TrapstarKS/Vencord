/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { RestartIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { FluxDispatcher, GuildMemberStore, GuildStore, Menu, PresenceStore, showToast, Toasts, UserProfileStore, UserStore } from "@webpack/common";

const CUSTOM_STATUS_ACTIVITY_TYPE = 4;

const settings = definePluginSettings({
    pokeMemberRequest: {
        type: OptionType.BOOLEAN,
        description: "Also fire a member request to the mutual servers (refreshes member data; note: on a user account this does NOT return presence)",
        default: true
    },
    fallbackToAllGuilds: {
        type: OptionType.BOOLEAN,
        description: "When no mutual server is known, poke joined servers too",
        default: false,
        disabled() {
            return !this.store.pokeMemberRequest;
        }
    },
    fallbackGuildLimit: {
        type: OptionType.SLIDER,
        description: "Maximum joined servers to poke when the mutual server is unknown",
        markers: [5, 10, 25, 50, 100, 250],
        default: 50,
        stickToMarkers: true,
        disabled() {
            return !this.store.pokeMemberRequest || !this.store.fallbackToAllGuilds;
        }
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast with the user's real, currently-known presence",
        default: true
    }
});

function unique<T>(items: T[]) {
    return [...new Set(items)];
}

function tryOr<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

function getKnownMutualGuildIds(userId: string, contextGuildId?: string) {
    const allGuildIds = Object.keys(GuildStore.getGuilds());
    const contextGuildIds = contextGuildId ? [contextGuildId] : [];
    const cachedGuildIds = allGuildIds.filter(guildId => GuildMemberStore.isMember(guildId, userId));
    const profileGuildIds = UserProfileStore.getMutualGuilds(userId)?.map(({ guild }) => guild.id) ?? [];

    return unique([...contextGuildIds, ...cachedGuildIds, ...profileGuildIds]);
}

function getFallbackGuildIds() {
    if (!settings.store.fallbackToAllGuilds) return [];

    return Object.keys(GuildStore.getGuilds()).slice(0, settings.store.fallbackGuildLimit);
}

/**
 * The source of truth for what Discord actually shows: the PresenceStore. For friends this is
 * already live and correct, so "forcing" a refresh has nothing to update — the button's real job
 * is to surface this so you can tell "offline" (no data) apart from a genuinely offline user.
 */
function getPresenceReport(userId: string) {
    const status = tryOr(() => PresenceStore.getStatus(userId, null, "offline"), "offline");
    const hasData = tryOr(() => PresenceStore.getUserIds().includes(userId), false);
    const onMobile = tryOr(() => PresenceStore.isMobileOnline(userId), false);
    const customStatus = tryOr(
        () => PresenceStore.getActivities(userId)?.find(a => a?.type === CUSTOM_STATUS_ACTIVITY_TYPE)?.state,
        undefined
    );

    const parts = [onMobile && status !== "offline" ? `${status} 📱` : status];
    if (customStatus) parts.push(`"${customStatus}"`);

    return { status, hasData, text: parts.join(" · ") };
}

function pokeMemberRequest(user: User, contextGuildId?: string) {
    const knownGuildIds = getKnownMutualGuildIds(user.id, contextGuildId);
    const requestGuildIds = knownGuildIds.length ? knownGuildIds : getFallbackGuildIds();
    if (!requestGuildIds.length) return;

    // Refreshes member data for the mutual servers. Presence is NOT delivered this way on a user
    // account (the gateway returns the member without a presence), so we do not rely on the result.
    FluxDispatcher.dispatch({
        type: "GUILD_MEMBERS_REQUEST",
        guildIds: requestGuildIds,
        userIds: [user.id],
        presences: true
    });
}

function forcePresenceUpdate(user: User, contextGuildId?: string) {
    if (settings.store.pokeMemberRequest) pokeMemberRequest(user, contextGuildId);

    if (!settings.store.showToast) return;

    const { status, hasData, text } = getPresenceReport(user.id);

    if (status !== "offline") {
        showToast(`${user.username}: ${text}`, Toasts.Type.SUCCESS);
    } else if (hasData) {
        showToast(`${user.username}: offline (o cliente tem a presença dele e diz offline)`, Toasts.Type.MESSAGE);
    } else {
        showToast(`${user.username}: sem presença conhecida — não é amigo ou o servidor não assina a presença dele`, Toasts.Type.FAILURE);
    }
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;

    children.splice(-1, 0,
        <Menu.MenuItem
            id="vc-force-presence-update"
            label="Force Presence Update"
            action={() => forcePresenceUpdate(user, guildId)}
            icon={RestartIcon}
        />
    );
};

export default definePlugin({
    name: "FasterFriendPresence",
    description: "Adds a user context menu button that reports a user's real, currently-known presence (and pokes a member refresh)",
    tags: ["Friends", "Utility"],
    searchTerms: ["presence", "status", "activity", "online"],
    authors: [Devs.trapstar],
    settings,

    contextMenus: {
        "user-context": userContextMenuPatch
    }
});
