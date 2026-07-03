/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { Menu, showToast, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    includeAuthor: {
        type: OptionType.BOOLEAN,
        description: "Prepend the author's name to the quote",
        default: true
    },
    includeJumpLink: {
        type: OptionType.BOOLEAN,
        description: "Append a link that jumps to the original message",
        default: true
    },
    includeAttachments: {
        type: OptionType.BOOLEAN,
        description: "Append attachment/embed links when the message has them",
        default: true
    },
    authorStyle: {
        type: OptionType.SELECT,
        description: "How the author line is formatted",
        options: [
            { label: "Bold name with colon — **Name:**", value: "bold", default: true },
            { label: "Em dash — — Name", value: "dash" },
            { label: "Plain — Name:", value: "plain" }
        ]
    }
});

const QuoteIcon = () => (
    <svg role="img" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6.5 10c-.223 0-.437.034-.65.065.069-.232.14-.468.254-.68.114-.308.292-.575.469-.844.148-.291.409-.488.601-.737.201-.242.475-.403.692-.604.213-.21.492-.315.714-.463.232-.133.434-.28.65-.35l.539-.222.474-.197-.484-1.938-.597.144c-.191.048-.424.104-.689.171-.271.05-.56.187-.882.312-.318.142-.686.238-1.028.466-.344.218-.741.4-1.091.692-.339.301-.748.562-1.05.945-.33.358-.656.734-.909 1.162-.293.408-.492.856-.702 1.299-.19.443-.343.896-.468 1.336-.237.882-.343 1.72-.384 2.437-.034.718-.014 1.315.028 1.747.015.204.043.402.063.539l.025.168.026-.006A4.5 4.5 0 106.5 10zm11 0c-.223 0-.437.034-.65.065.069-.232.14-.468.254-.68.114-.308.292-.575.469-.844.148-.291.409-.488.601-.737.201-.242.475-.403.692-.604.213-.21.492-.315.714-.463.232-.133.434-.28.65-.35l.539-.222.474-.197-.484-1.938-.597.144c-.191.048-.424.104-.689.171-.271.05-.56.187-.882.312-.318.142-.686.238-1.028.466-.344.218-.741.4-1.091.692-.339.301-.748.562-1.05.945-.33.358-.656.734-.909 1.162-.293.408-.492.856-.702 1.299-.19.443-.343.896-.468 1.336-.237.882-.343 1.72-.384 2.437-.034.718-.014 1.315.028 1.747.015.204.043.402.063.539l.025.168.026-.006A4.5 4.5 0 1017.5 10z" />
    </svg>
);

function buildQuote(message: Message, channel: Channel): string {
    const lines: string[] = [];

    const authorName = (message.author as any)?.globalName || message.author?.username || "Unknown";
    if (settings.store.includeAuthor) {
        switch (settings.store.authorStyle) {
            case "dash":
                lines.push(`— ${authorName}`);
                break;
            case "plain":
                lines.push(`${authorName}:`);
                break;
            default:
                lines.push(`**${authorName}:**`);
                break;
        }
    }

    const content = (message.content ?? "").trim();
    if (content) {
        for (const line of content.split("\n"))
            lines.push(`> ${line}`);
    } else if (!settings.store.includeAttachments) {
        lines.push("> *(no text content)*");
    }

    if (settings.store.includeAttachments) {
        const urls: string[] = [];
        for (const att of message.attachments ?? [])
            if (att?.url) urls.push(att.url);
        for (const embed of message.embeds ?? []) {
            const url = (embed as any)?.url || (embed as any)?.image?.url || (embed as any)?.thumbnail?.url;
            if (url) urls.push(url);
        }
        for (const url of urls)
            lines.push(`> ${url}`);
    }

    if (settings.store.includeJumpLink) {
        const guildId = channel?.guild_id ?? "@me";
        lines.push(`<https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}>`);
    }

    return lines.join("\n");
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message, channel }: { message: Message; channel: Channel; }) => {
    if (!message) return;

    children.push(
        <Menu.MenuItem
            id="vc-copy-message-as-quote"
            label="Copy as Quote"
            icon={QuoteIcon}
            action={() => {
                try {
                    copyToClipboard(buildQuote(message, channel));
                    showToast("Copied message as quote", Toasts.Type.SUCCESS);
                } catch {
                    showToast("Failed to copy quote", Toasts.Type.FAILURE);
                }
            }}
        />
    );
};

export default definePlugin({
    name: "CopyMessageAsQuote",
    description: "Adds a \"Copy as Quote\" option to the message context menu that copies a message as a Markdown blockquote with author attribution and a jump link, ready to paste elsewhere.",
    authors: [Devs.trapstar],
    tags: ["Utility", "Chat"],
    searchTerms: ["quote", "blockquote", "copy"],
    settings,
    contextMenus: {
        "message": messageContextMenuPatch
    }
});
