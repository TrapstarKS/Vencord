/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { close_switcher, jump_to } from "@plugins/dmSearch/api/navigation";
import { settings } from "@plugins/dmSearch/settings";
import { ChannelMeta, MessageHit } from "@plugins/dmSearch/types";
import { ChannelStore } from "@webpack/common";

export function open_hit(hit: MessageHit, channel_meta: ChannelMeta | undefined, on_keep_open: () => void): void {
    const channel = ChannelStore.getChannel(hit.channel_id);
    if (settings.store.keepOpenAfterJump) {
        on_keep_open();
    } else {
        close_switcher();
    }
    void jump_to(hit.channel_id, hit.id, channel?.guild_id, channel_meta);
}
