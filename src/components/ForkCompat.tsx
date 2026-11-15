/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fork-only compatibility layer. Upstream removed the deprecated Button/Text/Forms
// re-exports from @webpack/common and changed showToast to take an object.
// The fork's own plugins still use the old API, so this keeps them working.

import { showToast as upstreamShowToast } from "@webpack/common";

import { Button as NewButton, type ButtonProps, type ButtonSize, TextButton, type TextButtonProps } from "./Button";
import { Divider } from "./Divider";
import { Heading } from "./Heading";
import { Paragraph } from "./Paragraph";
import { Text as NewText, type TextProps, type TextSize, type TextWeight } from "./Text";

// #region Button

const ButtonColorMapping: Record<string, ButtonProps["variant"]> = {
    BRAND: "primary",
    PRIMARY: "secondary",
    RED: "dangerPrimary",
    TRANSPARENT: "secondary",
    CUSTOM: "none",
    GREEN: "positive",
    LINK: "link",
    WHITE: "overlayPrimary"
};

const TextButtonColorMapping: Record<string, TextButtonProps["variant"]> = {
    BRAND: "primary",
    PRIMARY: "primary",
    RED: "danger",
    TRANSPARENT: "secondary",
    CUSTOM: "secondary",
    GREEN: "primary",
    LINK: "link",
    WHITE: "secondary"
};

function ButtonCompatImpl({ look, color = "BRAND", size = "medium", ...restProps }: any) {
    return look === "LINK"
        ? <TextButton variant={TextButtonColorMapping[color]} {...restProps as TextButtonProps} />
        : <NewButton variant={ButtonColorMapping[color]} size={size as ButtonSize} {...restProps as ButtonProps} />;
}

export const Button = Object.assign(ButtonCompatImpl, {
    Looks: { FILLED: "", LINK: "LINK" },
    Colors: {
        BRAND: "BRAND",
        PRIMARY: "PRIMARY",
        RED: "RED",
        TRANSPARENT: "TRANSPARENT",
        CUSTOM: "CUSTOM",
        GREEN: "GREEN",
        LINK: "LINK",
        WHITE: "WHITE",
    },
    Sizes: {
        SMALL: "small",
        MEDIUM: "medium",
        LARGE: "medium",
        XLARGE: "medium",
        NONE: "min",
        MIN: "min"
    }
} as const);

// #endregion

// #region Text

export function Text({ color, variant, ...restProps }: any) {
    const props = restProps as TextProps;

    if (variant) {
        const [left, right] = String(variant).split("/");
        if (left && right) {
            props.size = left.split("-").pop() as TextSize;
            props.weight = right as TextWeight;
        }
    }

    if (color) {
        props.style = { ...props.style, color: `var(--${color}, var(--text-default))` };
    }

    return <NewText {...props} />;
}

// #endregion

export const Forms = {
    FormTitle: Heading as any,
    FormText: Paragraph as any,
    FormSection: "section" as any,
    FormDivider: Divider as any,
};

// #region Toasts

const ToastVariantMapping = {
    message: "default",
    success: "success",
    failure: "critical",
} as const;

export function showToast(text: string, type: keyof typeof ToastVariantMapping = "message") {
    upstreamShowToast({ text, variant: ToastVariantMapping[type] ?? "default" });
}

// #endregion
