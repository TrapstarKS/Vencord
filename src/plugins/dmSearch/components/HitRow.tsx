/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelMeta, MessageEmbed, MessageHit, SearchTab } from "@plugins/dmSearch/types";
import { avatar_url } from "@plugins/dmSearch/utils/avatar";
import { channel_info } from "@plugins/dmSearch/utils/channel";
import { fmt_bytes, fmt_time, fmt_time_full, hostname } from "@plugins/dmSearch/utils/format";
import { highlight } from "@plugins/dmSearch/utils/highlight";
import { media_thumbs } from "@plugins/dmSearch/utils/media";
import { open_hit } from "@plugins/dmSearch/utils/open";
import { UserStore } from "@webpack/common";

interface Props {
    hit: MessageHit;
    query: string;
    tab: SearchTab;
    channel_meta: ChannelMeta | undefined;
    on_keep_open: () => void;
}

export function HitRow({ hit, query, tab, channel_meta, on_keep_open }: Props) {
    const me = UserStore.getCurrentUser?.();
    const is_self = !!me && hit.author?.id === me.id;
    const info = channel_info(hit.channel_id, channel_meta);
    const author = hit.author?.global_name || hit.author?.username || "Unknown";
    const is_bot = !!hit.author?.bot;

    return (
        <div
            className="vc-dms-row"
            onMouseDown={e => {
                e.preventDefault();
                e.stopPropagation();
            }}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                open_hit(hit, channel_meta, on_keep_open);
            }}
        >
            <img
                className="vc-dms-avatar"
                src={avatar_url(hit.author?.id, hit.author?.avatar)}
                alt=""
                loading="lazy"
            />
            <div className="vc-dms-body">
                <div className="vc-dms-meta">
                    <span className="vc-dms-author">{author}</span>
                    {info.kind === "dm" && <span className="vc-dms-tag">DM</span>}
                    {info.kind === "dm" && is_self && <span className="vc-dms-context">to {info.target}</span>}
                    {info.kind === "group" && <span className="vc-dms-tag">GROUP</span>}
                    {info.kind === "group" && <span className="vc-dms-context">{info.target}</span>}
                    {info.kind === "server" && <span className="vc-dms-context">{info.target}</span>}
                    {info.kind === "server" && info.server && <span className="vc-dms-context-muted">{info.server}</span>}
                    {is_bot && <span className="vc-dms-bot-tag">BOT</span>}
                    <span className="vc-dms-time" title={fmt_time_full(hit.timestamp)}>{fmt_time(hit.timestamp)}</span>
                </div>
                <Body hit={hit} query={query} tab={tab} />
            </div>
        </div>
    );
}

function Body({ hit, query, tab }: { hit: MessageHit; query: string; tab: SearchTab; }) {
    if (tab === "media") return <MediaBody hit={hit} />;
    if (tab === "files") return <FilesBody hit={hit} query={query} />;
    if (tab === "links") return <LinksBody hit={hit} query={query} />;
    return <TextBody content={hit.content} query={query} clamped={tab !== "pins"} />;
}

function TextBody({ content, query, clamped = true }: { content: string; query: string; clamped?: boolean; }) {
    if (!content) {
        return <div className="vc-dms-text"><span className="vc-dms-muted">[no text]</span></div>;
    }
    return <div className={"vc-dms-text" + (clamped ? "" : " vc-dms-text-full")}>{highlight(content, query)}</div>;
}

function MediaBody({ hit }: { hit: MessageHit; }) {
    const items = media_thumbs(hit);
    return (
        <div className="vc-dms-media">
            {items.length > 0 && (
                <div className="vc-dms-thumbs">
                    {items.slice(0, 4).map(item => item.video
                        ? <video key={item.key} className="vc-dms-thumb" src={item.src} muted preload="metadata" />
                        : <img key={item.key} className="vc-dms-thumb" src={item.src} alt="" loading="lazy" />
                    )}
                </div>
            )}
            {hit.content && <TextBody content={hit.content} query="" />}
        </div>
    );
}

function FilesBody({ hit, query }: { hit: MessageHit; query: string; }) {
    const files = (hit.attachments ?? []).filter(f =>
        !f.content_type?.startsWith?.("image/")
        && !f.content_type?.startsWith?.("video/")
        && !f.content_type?.startsWith?.("audio/")
    );
    return (
        <div className="vc-dms-files">
            {files.map(f => (
                <div key={f.id} className="vc-dms-file">
                    <span className="vc-dms-file-name">{f.filename ?? "file"}</span>
                    <span className="vc-dms-file-meta">{`${f.content_type ?? "file"} · ${fmt_bytes(f.size ?? 0)}`}</span>
                </div>
            ))}
            {hit.content && <TextBody content={hit.content} query={query} />}
        </div>
    );
}

function LinksBody({ hit, query }: { hit: MessageHit; query: string; }) {
    const embeds = (hit.embeds ?? []).filter(e => e.url);

    if (!embeds.length) {
        const urls = (hit.content ?? "").match(/https?:\/\/[^\s<>"]+/g) ?? [];
        return (
            <div className="vc-dms-links">
                {urls.slice(0, 5).map((u, i) => <span key={i} className="vc-dms-link">{u}</span>)}
                {hit.content && <TextBody content={hit.content} query={query} />}
            </div>
        );
    }

    // Most link hits are just a bare URL as the whole message — the card below already
    // shows it, so repeating it as plain text underneath would be pure noise.
    const content_is_bare_link = /^https?:\/\/\S+$/.test((hit.content ?? "").trim());

    return (
        <div className="vc-dms-links">
            {embeds.slice(0, 3).map((e, i) => <LinkCard key={i} embed={e} />)}
            {hit.content && !content_is_bare_link && <TextBody content={hit.content} query={query} />}
        </div>
    );
}

function LinkCard({ embed }: { embed: MessageEmbed; }) {
    const thumb = embed.thumbnail?.proxy_url ?? embed.image?.proxy_url;
    const title = embed.title || embed.url;
    const site = embed.provider?.name || hostname(embed.url);

    return (
        <div className="vc-dms-link-card">
            {thumb && <img className="vc-dms-link-thumb" src={thumb} alt="" loading="lazy" />}
            <div className="vc-dms-link-info">
                <span className="vc-dms-link-title">{title}</span>
                {site && <span className="vc-dms-link-site">{site}</span>}
            </div>
        </div>
    );
}
