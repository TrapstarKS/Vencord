/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderModalProps } from "@vencord/discord-types";
import { Forms, Modal, openModal, React, TextInput, Toasts, useState } from "@webpack/common";

import { VaultSourceAccount } from "./accounts";
import { getVaultAvatarUrl, syncVaultFromDiscord, unlockVault } from "./vault";

export type VaultUnlockReason = "startup" | "switch" | "new-account";

export interface VaultUnlockPromptOptions {
    reason: VaultUnlockReason;
    missingAccounts?: VaultSourceAccount[];
    onDismiss?(): void;
    onUnlocked?(): void;
}

const COPY: Record<VaultUnlockReason, { title: string; subtitle: string; }> = {
    startup: {
        title: "Unlock account vault?",
        subtitle: "Automatic token backup is paused while the vault is locked. Unlock once so new logins are saved."
    },
    switch: {
        title: "Unlock vault after account switch?",
        subtitle: "You switched accounts while the vault was locked. Unlock to keep the encrypted backup up to date."
    },
    "new-account": {
        title: "Save new account(s) to vault?",
        subtitle: "These accounts are logged in but not in your encrypted backup yet. Unlock to save them by user ID."
    }
};

function MissingAccountRow({ account }: { account: VaultSourceAccount; }) {
    const displayName = account.globalName || account.username;

    return (
        <div className="vc-moreAccounts-accountCard vc-moreAccounts-promptAccount">
            <img
                className="vc-moreAccounts-avatar"
                src={getVaultAvatarUrl({
                    id: account.id,
                    username: account.username,
                    avatar: account.avatar,
                    discriminator: account.discriminator,
                    globalName: account.globalName,
                    note: null,
                    updatedAt: ""
                })}
                alt=""
                aria-hidden="true"
            />
            <div className="vc-moreAccounts-accountInfo">
                <div className="vc-moreAccounts-accountName">{displayName}</div>
                <div className="vc-moreAccounts-accountMeta">@{account.username}</div>
            </div>
        </div>
    );
}

function VaultUnlockDialog({
    modalProps,
    reason,
    missingAccounts = [],
    markFinished,
    onDismiss,
    onUnlocked
}: {
    modalProps: RenderModalProps;
    reason: VaultUnlockReason;
    missingAccounts?: VaultSourceAccount[];
    markFinished(): boolean;
    onDismiss?(): void;
    onUnlocked?(): void;
}) {
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const copy = COPY[reason];
    const showMissing = missingAccounts.length > 0;

    async function handleUnlock() {
        if (!password || busy) return;

        setBusy(true);
        setError(null);

        try {
            await unlockVault(password);
            const result = await syncVaultFromDiscord();
            const changes = result.added + result.updated;

            Toasts.show({
                message: changes
                    ? `Vault unlocked · ${result.added} new, ${result.updated} updated account(s) saved.`
                    : "Vault unlocked.",
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS
            });

            if (markFinished()) onUnlocked?.();
            modalProps.onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not unlock the vault.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            {...modalProps}
            title={copy.title}
            subtitle={copy.subtitle}
            size="md"
            notice={error ? { message: error, type: "critical" } : undefined}
            actions={[
                {
                    text: "Not now",
                    variant: "secondary",
                    onClick: () => {
                        if (markFinished()) onDismiss?.();
                        modalProps.onClose();
                    },
                    disabled: busy
                },
                {
                    text: busy ? "Unlocking…" : "Unlock & save",
                    variant: "primary",
                    onClick: () => void handleUnlock(),
                    loading: busy,
                    disabled: busy || !password
                }
            ]}
        >
            <div className="vc-moreAccounts-promptBody">
                {showMissing && (
                    <div className="vc-moreAccounts-promptList">
                        {missingAccounts.map(account => (
                            <MissingAccountRow key={account.id} account={account} />
                        ))}
                    </div>
                )}

                <Forms.FormTitle tag="h5">Vault password</Forms.FormTitle>
                <TextInput
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Vault password"
                    disabled={busy}
                    autoFocus
                    onKeyDown={event => {
                        if (event.key === "Enter" && password) void handleUnlock();
                    }}
                />
            </div>
        </Modal>
    );
}

export function openVaultUnlockModal(options: VaultUnlockPromptOptions) {
    let finished = false;
    const markFinished = () => {
        if (finished) return false;
        finished = true;
        return true;
    };

    return openModal(
        modalProps => (
            <VaultUnlockDialog
                modalProps={modalProps}
                reason={options.reason}
                missingAccounts={options.missingAccounts}
                markFinished={markFinished}
                onDismiss={options.onDismiss}
                onUnlocked={options.onUnlocked}
            />
        ),
        {
            onCloseCallback: () => {
                // Backdrop / ESC: treat as dismiss only if unlock / Not now did not already finish.
                if (markFinished()) options.onDismiss?.();
            }
        }
    );
}
