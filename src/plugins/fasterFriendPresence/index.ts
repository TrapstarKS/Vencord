/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, PresenceStore, RelationshipStore, SelectedChannelStore, UserProfileStore, UserStore } from "@webpack/common";

const GATEWAY_USER_BATCH_LIMIT = 100;
const USER_ID_REGEX = /\d{17,20}/g;

let refreshIntervalId: ReturnType<typeof setInterval> | undefined;
let queuedRefreshId: ReturnType<typeof setTimeout> | undefined;
let nextFriendIndex = 0;

const settings = definePluginSettings({
    refreshInterval: {
        type: OptionType.SLIDER,
        description: "How often to refresh friend presences, in seconds",
        markers: [5, 10, 15, 30, 45, 60, 90, 120],
        default: 30,
        stickToMarkers: true,
        onChange: restartRefreshInterval
    },
    friendBatchSize: {
        type: OptionType.SLIDER,
        description: "How many friends to refresh per interval",
        markers: [10, 25, 50, 75, 100],
        default: 25,
        stickToMarkers: true,
        disabled() {
            return !this.store.refreshAllFriends;
        }
    },
    refreshOpenDm: {
        type: OptionType.BOOLEAN,
        description: "Always refresh the currently open DM or group DM",
        default: true,
        onChange: () => queueRefresh()
    },
    includeGroupDms: {
        type: OptionType.BOOLEAN,
        description: "Include every recipient in the currently open group DM",
        default: true,
        disabled() {
            return !this.store.refreshOpenDm;
        },
        onChange: () => queueRefresh()
    },
    refreshOnChannelSwitch: {
        type: OptionType.BOOLEAN,
        description: "Refresh immediately when switching to another DM",
        default: true
    },
    channelSwitchDelay: {
        type: OptionType.SLIDER,
        description: "Delay before refreshing after switching channels, in milliseconds",
        markers: [0, 250, 500, 1000, 2000],
        default: 500,
        stickToMarkers: true,
        disabled() {
            return !this.store.refreshOnChannelSwitch;
        }
    },
    refreshAllFriends: {
        type: OptionType.BOOLEAN,
        description: "Also refresh friends in rotating batches. This is heavier on the gateway",
        default: false,
        onChange() {
            nextFriendIndex = 0;
            queueRefresh();
        }
    },
    refreshOfflineFriends: {
        type: OptionType.BOOLEAN,
        description: "Include friends currently cached as offline in rotating batches",
        default: true,
        disabled() {
            return !this.store.refreshAllFriends;
        }
    },
    extraUserIds: {
        type: OptionType.STRING,
        description: "Extra user IDs to refresh every interval. Separate IDs with spaces, commas, or new lines",
        default: "",
        multiline: true,
        onChange: () => queueRefresh()
    },
    fallbackToAllGuilds: {
        type: OptionType.BOOLEAN,
        description: "Try joined servers when Discord has not cached a mutual server for a user",
        default: true
    },
    fallbackGuildLimit: {
        type: OptionType.SLIDER,
        description: "Maximum joined servers to try per unknown user",
        markers: [5, 10, 25, 50, 100, 250],
        default: 50,
        stickToMarkers: true,
        disabled() {
            return !this.store.fallbackToAllGuilds;
        }
    },
    pauseWhenHidden: {
        type: OptionType.BOOLEAN,
        description: "Pause refreshes while Discord is in the background",
        default: true
    },
    refreshWhenVisible: {
        type: OptionType.BOOLEAN,
        description: "Refresh once when Discord becomes visible again",
        default: true
    },
    refreshOnReconnect: {
        type: OptionType.BOOLEAN,
        description: "Refresh once after Discord reconnects",
        default: true
    }
});

function unique<T>(items: T[]) {
    return [...new Set(items)];
}

function getAllGuildIds() {
    return Object.keys(GuildStore.getGuilds());
}

function getExtraUserIds() {
    return unique(settings.store.extraUserIds.match(USER_ID_REGEX) ?? []);
}

function getCurrentDmRecipientIds() {
    const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
    if (!channel?.isDM?.() && !(settings.store.includeGroupDms && channel?.isGroupDM?.())) return [];

    const currentUserId = UserStore.getCurrentUser()?.id;
    return (channel.recipients ?? []).filter(id => id && id !== currentUserId);
}

function getFriendBatch() {
    if (!settings.store.refreshAllFriends) return [];

    const friendIds = RelationshipStore.getFriendIDs();
    if (!friendIds.length) return [];

    const candidates = settings.store.refreshOfflineFriends
        ? friendIds
        : friendIds.filter(id => PresenceStore.getStatus(id, null, "offline") !== "offline");

    if (!candidates.length) return [];

    const batchSize = Math.min(settings.store.friendBatchSize, candidates.length);
    const batch = [] as string[];

    for (let i = 0; i < batchSize; i++) {
        batch.push(candidates[(nextFriendIndex + i) % candidates.length]);
    }

    nextFriendIndex = (nextFriendIndex + batch.length) % candidates.length;
    return batch;
}

function getKnownMutualGuildIds(userId: string, allGuildIds: string[]) {
    const cachedGuildIds = allGuildIds.filter(guildId => GuildMemberStore.isMember(guildId, userId));
    const profileGuildIds = UserProfileStore.getMutualGuilds(userId)?.map(({ guild }) => guild.id) ?? [];

    return unique([...cachedGuildIds, ...profileGuildIds]);
}

function requestPresences(userIds: string[]) {
    const allGuildIds = getAllGuildIds();
    if (!allGuildIds.length || !userIds.length) return;

    const requestGroups = new Map<string, string[]>();

    for (const userId of userIds) {
        const knownGuildIds = getKnownMutualGuildIds(userId, allGuildIds);
        const guildIds = knownGuildIds.length
            ? knownGuildIds
            : settings.store.fallbackToAllGuilds
                ? allGuildIds.slice(0, settings.store.fallbackGuildLimit)
                : [];

        if (!guildIds.length) continue;

        const key = guildIds.join(",");

        requestGroups.get(key)?.push(userId) ?? requestGroups.set(key, [userId]);
    }

    for (const [guildIdsKey, groupUserIds] of requestGroups) {
        const guildIds = guildIdsKey.split(",");

        for (let i = 0; i < groupUserIds.length; i += GATEWAY_USER_BATCH_LIMIT) {
            FluxDispatcher.dispatch({
                type: "GUILD_MEMBERS_REQUEST",
                guildIds,
                userIds: groupUserIds.slice(i, i + GATEWAY_USER_BATCH_LIMIT),
                presences: true
            });
        }
    }
}

function refreshPresences() {
    if (settings.store.pauseWhenHidden && document.visibilityState === "hidden") return;

    const userIds = [] as string[];

    if (settings.store.refreshOpenDm) {
        userIds.push(...getCurrentDmRecipientIds());
    }

    userIds.push(...getFriendBatch());
    userIds.push(...getExtraUserIds());
    requestPresences(unique(userIds));
}

function queueRefresh(delay = 500) {
    clearTimeout(queuedRefreshId);
    queuedRefreshId = setTimeout(refreshPresences, delay);
}

function restartRefreshInterval() {
    if (!refreshIntervalId) return;

    stopRefreshInterval();
    startRefreshInterval();
}

function startRefreshInterval() {
    stopRefreshInterval();

    queueRefresh(500);
    refreshIntervalId = setInterval(refreshPresences, settings.store.refreshInterval * 1000);
}

function stopRefreshInterval() {
    clearInterval(refreshIntervalId);
    clearTimeout(queuedRefreshId);

    refreshIntervalId = undefined;
    queuedRefreshId = undefined;
}

function onVisibilityChange() {
    if (settings.store.refreshWhenVisible && document.visibilityState === "visible") {
        queueRefresh();
    }
}

export default definePlugin({
    name: "FasterFriendPresence",
    description: "Refreshes friend presences more frequently",
    tags: ["Friends", "Utility"],
    searchTerms: ["presence", "status", "activity", "online"],
    authors: [Devs.trapstar],
    settings,

    start() {
        document.addEventListener("visibilitychange", onVisibilityChange);
        startRefreshInterval();
    },

    stop() {
        stopRefreshInterval();
        document.removeEventListener("visibilitychange", onVisibilityChange);
    },

    flux: {
        CHANNEL_SELECT() {
            if (settings.store.refreshOpenDm && settings.store.refreshOnChannelSwitch) {
                queueRefresh(settings.store.channelSwitchDelay);
            }
        },
        CONNECTION_OPEN() {
            if (settings.store.refreshOnReconnect) queueRefresh();
        },
        RELATIONSHIP_ADD() {
            nextFriendIndex = 0;
        },
        RELATIONSHIP_REMOVE() {
            nextFriendIndex = 0;
        }
    }
});
