/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { Devs } from "@utils/constants";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

let style: HTMLStyleElement;

// Selectors derived from Discord's real chat-input DOM. Each button is
// identified by the most stable handle it exposes:
//  - Sticker: its inner button carries a "stickerButton" module class.
//  - Emoji:   its inner button carries an "emojiButton" module class.
//  - GIF:     the only expression-picker button with no semantic class, so it's
//             matched as "the expression button that is neither sticker nor emoji"
//             (Vencord's own buttons are excluded via .vc-chatbar-button).
//  - Gift:    no button class, but its icon is uniquely "trinketsIcon".
//  - Apps/Activities: a stable, non-hashed "app-launcher-entrypoint" class.
const EXPR = ".expression-picker-chat-input-button";

const SELECTORS: Record<string, string> = {
    hideSticker: `${EXPR}:has([class*="stickerButton"])`,
    hideEmoji: `${EXPR}:has([class*="emojiButton"])`,
    hideGif: `${EXPR}:not(.vc-chatbar-button):has(> [role="button"]):not(:has([class*="stickerButton"])):not(:has([class*="emojiButton"]))`,
    hideGift: "[class*='container']:has(> [role='button'] [class*='trinketsIcon'])",
    hideActivities: ".app-launcher-entrypoint"
};

function setCss() {
    const s = settings.store as Record<string, boolean>;

    const selectors = Object.entries(SELECTORS)
        .filter(([key]) => s[key])
        .map(([, selector]) => selector);

    style.textContent = selectors.length
        ? `${selectors.join(",\n")} {\n    display: none !important;\n}`
        : "";
}

const settings = definePluginSettings({
    hideGift: {
        type: OptionType.BOOLEAN,
        description: "Hide the gift (Nitro) button",
        default: true,
        onChange: setCss
    },
    hideGif: {
        type: OptionType.BOOLEAN,
        description: "Hide the GIF button",
        default: true,
        onChange: setCss
    },
    hideSticker: {
        type: OptionType.BOOLEAN,
        description: "Hide the sticker button",
        default: true,
        onChange: setCss
    },
    hideActivities: {
        type: OptionType.BOOLEAN,
        description: "Hide the activities / apps launcher button",
        default: true,
        onChange: setCss
    },
    hideEmoji: {
        type: OptionType.BOOLEAN,
        description: "Hide the emoji button",
        default: false,
        onChange: setCss
    }
});

export default definePlugin({
    name: "HideChatIcons",
    description: "Hide chat input buttons you don't use (GIF, sticker, gift, activities, emoji)",
    authors: [Devs.trapstar],
    tags: ["Appearance", "Chat", "Customisation"],
    settings,

    start() {
        style = createAndAppendStyle("VcHideChatIcons", managedStyleRootNode);
        setCss();
    },

    stop() {
        style?.remove();
    }
});
