/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelMeta, MessageHit } from "@plugins/dmSearch/types";
import { avatar_url } from "@plugins/dmSearch/utils/avatar";
import { fmt_time_full } from "@plugins/dmSearch/utils/format";
import { media_thumbs, Thumb } from "@plugins/dmSearch/utils/media";
import { open_hit } from "@plugins/dmSearch/utils/open";

interface Cell extends Thumb {
    hit: MessageHit;
}

interface Props {
    hits: MessageHit[];
    channels: Map<string, ChannelMeta>;
    on_keep_open: () => void;
}

export function MediaGrid({ hits, channels, on_keep_open }: Props) {
    const cells: Cell[] = [];
    for (const hit of hits) {
        for (const thumb of media_thumbs(hit)) cells.push({ ...thumb, hit });
    }

    return (
        <div className="vc-dms-media-grid">
            {cells.map(cell => {
                const author = cell.hit.author?.global_name || cell.hit.author?.username || "Unknown";
                return (
                    <div
                        key={`${cell.hit.id}-${cell.key}`}
                        className="vc-dms-media-cell"
                        title={`${author} · ${fmt_time_full(cell.hit.timestamp)}`}
                        onMouseDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            open_hit(cell.hit, channels.get(cell.hit.channel_id), on_keep_open);
                        }}
                    >
                        {cell.video
                            ? <video className="vc-dms-media-cell-media" src={cell.src} muted preload="metadata" />
                            : <img className="vc-dms-media-cell-media" src={cell.src} alt="" loading="lazy" />
                        }
                        <img
                            className="vc-dms-media-cell-avatar"
                            src={avatar_url(cell.hit.author?.id, cell.hit.author?.avatar)}
                            alt=""
                            loading="lazy"
                        />
                    </div>
                );
            })}
        </div>
    );
}
