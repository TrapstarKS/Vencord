/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { copyWithToast } from "@utils/discord";
import { chooseFile, saveFile } from "@utils/web";
import { Button, ConfirmModal, Forms, openModal, React, TextInput, Toasts, useState } from "@webpack/common";

import {
    type AccountSessionStatus,
    getAccountSessionStatus,
    getLastKnownProfile,
    getTokenHealth,
    loadAvatarCache,
    subscribeTokenHealth,
    type TokenHealthStatus
} from "./accounts";
import {
    changeVaultPassword,
    checkUnlockedVaultTokenHealth,
    createVault,
    deleteVault,
    exportVaultBackup,
    getUnlockedVaultToken,
    getVaultAvatarUrl,
    getVaultSnapshot,
    importVaultBackup,
    initializeVault,
    lockVault,
    PublicVaultAccount,
    removeVaultAccount,
    restoreVaultAccounts,
    scrubInvalidVaultAccounts,
    setVaultAccountNote,
    subscribeVault,
    switchToVaultAccount,
    syncVaultFromDiscord,
    unlockVault
} from "./vault";

interface StatusMessage {
    text: string;
    error?: boolean;
}

function formatDate(value: string | null) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

async function readBackupFile(): Promise<string | null> {
    if (IS_DISCORD_DESKTOP) {
        const [file] = await DiscordNative.fileManager.openFiles({
            filters: [
                { name: "MoreAccounts encrypted backup", extensions: ["vma", "json"] },
                { name: "All files", extensions: ["*"] }
            ]
        });

        return file ? new TextDecoder().decode(file.data) : null;
    }

    const file = await chooseFile(".vma,application/json");
    return file ? file.text() : null;
}

async function downloadBackup(raw: string) {
    const date = new Date().toISOString().slice(0, 10);
    const filename = `more-accounts-backup-${date}.vma`;
    const data = new TextEncoder().encode(raw);

    if (IS_DISCORD_DESKTOP) {
        await DiscordNative.fileManager.saveWithDialog(data, filename);
    } else {
        saveFile(new File([data], filename, { type: "application/json" }));
    }
}

const STATUS_LABEL: Record<AccountSessionStatus, string> = {
    current: "Current",
    active: "In switcher",
    needs_login: "Sign in again",
    ready: "Ready"
};

const STATUS_CLASS: Record<AccountSessionStatus, string> = {
    current: "vc-moreAccounts-badgeCurrent",
    active: "vc-moreAccounts-badgeActive",
    needs_login: "vc-moreAccounts-badgeNeedsLogin",
    ready: "vc-moreAccounts-badgeReady"
};

const TOKEN_HEALTH_LABEL: Record<TokenHealthStatus, string> = {
    valid: "Token OK",
    invalid: "Token dead",
    mismatch: "Wrong user",
    unknown: "Token ?",
    checking: "Checking…",
    unchecked: "Not checked"
};

const TOKEN_HEALTH_CLASS: Record<TokenHealthStatus, string> = {
    valid: "vc-moreAccounts-tokenValid",
    invalid: "vc-moreAccounts-tokenInvalid",
    mismatch: "vc-moreAccounts-tokenMismatch",
    unknown: "vc-moreAccounts-tokenUnknown",
    checking: "vc-moreAccounts-tokenChecking",
    unchecked: "vc-moreAccounts-tokenUnchecked"
};

const TOKEN_HEALTH_TITLE: Record<TokenHealthStatus, string> = {
    valid: "This vault token is accepted by Discord (/users/@me).",
    invalid: "Discord rejected this token (expired / revoked / logged out for real).",
    mismatch: "Token works but belongs to a different user id than this vault entry.",
    unknown: "Could not verify (network error or Discord throttled the check).",
    checking: "Probing Discord with this token…",
    unchecked: "Not checked yet — use “Check tokens” or unlock with auto-check on."
};

function enrichAccount(account: PublicVaultAccount): PublicVaultAccount {
    const last = getLastKnownProfile(account.id);
    if (!last) return account;

    const usernameLooksPlaceholder = account.username.startsWith("Account ");
    return {
        ...account,
        username: usernameLooksPlaceholder && last.username && !last.username.startsWith("Account ")
            ? last.username
            : account.username,
        avatar: account.avatar ?? last.avatar,
        globalName: account.globalName ?? last.globalName,
        discriminator: account.discriminator !== "0" ? account.discriminator : last.discriminator
    };
}

function AccountCard({ account: rawAccount, busy, onRestore, onSwitch, onRemove, onNote }: {
    account: PublicVaultAccount;
    busy: boolean;
    onRestore(account: PublicVaultAccount): void;
    onSwitch(account: PublicVaultAccount): void;
    onRemove(account: PublicVaultAccount): void;
    onNote(account: PublicVaultAccount, note: string | null): void;
}) {
    const account = enrichAccount(rawAccount);
    const status = getAccountSessionStatus(account.id);
    const displayName = account.globalName || account.username;
    const [editingNote, setEditingNote] = useState(false);
    const [noteDraft, setNoteDraft] = useState(account.note ?? "");
    // Re-render when token health cache updates (check in progress / finished).
    const [, bumpHealth] = useState(0);
    React.useEffect(() => subscribeTokenHealth(() => bumpHealth(n => n + 1)), []);
    const tokenHealth = getTokenHealth(account.id);

    function handleCopyToken() {
        const token = getUnlockedVaultToken(account.id);
        if (!token) {
            Toasts.show({
                message: "This account has no valid token stored (garbage entry — try Lock/Unlock to scrub).",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }
        void copyWithToast(token, "Token copied.");
    }

    function commitNote() {
        const next = noteDraft.trim().slice(0, 64) || null;
        setEditingNote(false);
        if (next !== (account.note ?? null)) onNote(account, next);
    }

    return (
        <div className="vc-moreAccounts-accountCard">
            <div className="vc-moreAccounts-cardTop">
                <img
                    className="vc-moreAccounts-avatar"
                    src={getVaultAvatarUrl(account)}
                    alt=""
                    aria-hidden="true"
                />
                <div className="vc-moreAccounts-accountInfo">
                    <div className="vc-moreAccounts-accountTitleRow">
                        <span className="vc-moreAccounts-accountName" title={displayName}>
                            {displayName}
                        </span>
                    </div>
                    <div className="vc-moreAccounts-badgeRow">
                        <span
                            className={`vc-moreAccounts-statusBadge ${STATUS_CLASS[status]}`}
                            title="Where this account sits in the multi-account switcher"
                        >
                            {STATUS_LABEL[status]}
                        </span>
                        <span
                            className={`vc-moreAccounts-statusBadge ${TOKEN_HEALTH_CLASS[tokenHealth.status]}`}
                            title={TOKEN_HEALTH_TITLE[tokenHealth.status]}
                        >
                            {TOKEN_HEALTH_LABEL[tokenHealth.status]}
                        </span>
                    </div>
                    <div className="vc-moreAccounts-accountMeta" title={`@${account.username}`}>
                        @{account.username}
                    </div>
                    <div className="vc-moreAccounts-accountMeta vc-moreAccounts-accountSaved">
                        Saved {formatDate(account.updatedAt)}
                        {tokenHealth.checkedAt
                            ? ` · token checked ${new Date(tokenHealth.checkedAt).toLocaleString()}`
                            : ""}
                    </div>
                    {editingNote
                        ? (
                            <div className="vc-moreAccounts-noteEdit">
                                <TextInput
                                    value={noteDraft}
                                    onChange={setNoteDraft}
                                    placeholder="Label (e.g. main, work)"
                                    disabled={busy}
                                    maxLength={64}
                                    onKeyDown={event => {
                                        if (event.key === "Enter") commitNote();
                                        if (event.key === "Escape") {
                                            setNoteDraft(account.note ?? "");
                                            setEditingNote(false);
                                        }
                                    }}
                                />
                                <Button size={Button.Sizes.SMALL} disabled={busy} onClick={commitNote}>
                                    Save
                                </Button>
                            </div>
                        )
                        : (
                            <button
                                type="button"
                                className="vc-moreAccounts-noteBtn"
                                disabled={busy}
                                title={account.note ? `Note: ${account.note}` : "Add a short label"}
                                onClick={() => {
                                    setNoteDraft(account.note ?? "");
                                    setEditingNote(true);
                                }}
                            >
                                {account.note ? `Note: ${account.note}` : "Add label…"}
                            </button>
                        )}
                </div>
            </div>
            <div className="vc-moreAccounts-cardActions">
                {status !== "current" && (
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        disabled={busy}
                        onClick={() => onSwitch(account)}
                    >
                        Switch
                    </Button>
                )}
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.TRANSPARENT}
                    disabled={busy}
                    onClick={handleCopyToken}
                >
                    Copy token
                </Button>
                {status !== "current" && status !== "active" && (
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.TRANSPARENT}
                        disabled={busy}
                        onClick={() => onRestore(account)}
                    >
                        {status === "needs_login" ? "Repair" : "Restore"}
                    </Button>
                )}
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    disabled={busy}
                    onClick={() => onRemove(account)}
                >
                    Remove
                </Button>
            </div>
        </div>
    );
}

export function VaultSection() {
    const [snapshot, setSnapshot] = useState(getVaultSnapshot);
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [importPassword, setImportPassword] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    React.useEffect(() => {
        const refresh = () => setSnapshot(getVaultSnapshot());
        const unsubscribe = subscribeVault(refresh);
        void Promise.all([initializeVault(), loadAvatarCache()])
            .then(async () => {
                // Clean soft-logout garbage rows (non-snowflake ids / empty tokens).
                if (getVaultSnapshot().unlocked) {
                    const removed = await scrubInvalidVaultAccounts().catch(() => 0);
                    if (removed) {
                        setMessage({
                            text: `Removed ${removed} invalid vault entr${removed === 1 ? "y" : "ies"}.`
                        });
                    }
                }
                refresh();
            })
            .catch(() => {
                setMessage({ text: "Could not read the local vault.", error: true });
            });
        return unsubscribe;
    }, []);

    async function run(operation: () => Promise<StatusMessage | void>) {
        setBusy(true);
        setMessage(null);
        try {
            const result = await operation();
            if (result) setMessage(result);
        } catch (error) {
            setMessage({
                text: error instanceof Error ? error.message : "The operation failed.",
                error: true
            });
        } finally {
            setBusy(false);
        }
    }

    function handleCreate() {
        void run(async () => {
            if (password !== confirmation) throw new Error("The passwords do not match.");
            const result = await createVault(password);
            setPassword("");
            setConfirmation("");
            return { text: `Vault created and ${result.added} account${result.added === 1 ? " was" : "s were"} saved.` };
        });
    }

    function handleUnlock() {
        void run(async () => {
            const scrubbedOnUnlock = await unlockVault(password);
            setPassword("");
            const scrubbed = scrubbedOnUnlock || await scrubInvalidVaultAccounts().catch(() => 0);
            const result = await syncVaultFromDiscord();
            const changes = result.added + result.updated;
            const parts = ["Vault unlocked"];
            if (scrubbed) parts.push(`${scrubbed} invalid entr${scrubbed === 1 ? "y" : "ies"} removed`);
            if (changes) parts.push(`${changes} account record(s) updated`);

            if (Settings.plugins.MoreAccounts?.checkTokenHealthOnUnlock !== false) {
                const health = await checkUnlockedVaultTokenHealth();
                parts.push(
                    `tokens: ${health.valid} OK` +
                    (health.invalid ? `, ${health.invalid} dead` : "") +
                    (health.mismatch ? `, ${health.mismatch} mismatch` : "") +
                    (health.unknown ? `, ${health.unknown} unknown` : "")
                );
            }

            return { text: `${parts.join(" · ")}.` };
        });
    }

    function handleCheckTokens() {
        void run(async () => {
            const health = await checkUnlockedVaultTokenHealth();
            return {
                text:
                    `Token check: ${health.valid}/${health.total} OK` +
                    (health.invalid ? ` · ${health.invalid} dead` : "") +
                    (health.mismatch ? ` · ${health.mismatch} wrong user` : "") +
                    (health.unknown ? ` · ${health.unknown} unknown` : "") +
                    ".",
                error: health.invalid > 0 || health.mismatch > 0
            };
        });
    }

    function handleSync() {
        void run(async () => {
            const result = await syncVaultFromDiscord();
            return {
                text: result.added || result.updated
                    ? `${result.added} new and ${result.updated} updated account(s) saved.`
                    : "The vault is already up to date."
            };
        });
    }

    function handleExport() {
        void run(async () => {
            await downloadBackup(await exportVaultBackup());
            return { text: "Encrypted backup exported. Keep the file and password separate." };
        });
    }

    function handleImport() {
        void run(async () => {
            const raw = await readBackupFile();
            if (raw == null) return;

            const backupPassword = snapshot.exists ? importPassword : password;
            if (!backupPassword) throw new Error("Enter the backup password first.");

            const result = await importVaultBackup(raw, backupPassword);
            setPassword("");
            setImportPassword("");
            return {
                text: `Backup opened: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged.`
            };
        });
    }

    function handleRestore(ids?: string[]) {
        void run(async () => {
            const result = await restoreVaultAccounts(ids);
            const parts = [`${result.restored}/${result.total} account(s) restored`];
            if (result.skipped) parts.push(`${result.skipped} already logged in (skipped)`);
            if (result.failed) parts.push(`${result.failed} could not be used`);

            // Surface per-account reasons (expired token, mismatch, etc.) instead of a vague summary.
            const detail = result.messages.length
                ? ` ${result.messages.join(" ")}`
                : "";

            return {
                text: `${parts.join(". ")}.${detail}`,
                error: result.failed > 0 && result.restored === 0 && result.skipped === 0
            };
        });
    }

    function handleSwitch(account: PublicVaultAccount) {
        void run(async () => {
            const result = await switchToVaultAccount(account.id);
            const label = account.globalName || account.username;
            if (result.ok && result.alreadyPresent) {
                return { text: `${label} is already the active session.` };
            }
            if (result.ok) {
                return { text: `Switching to ${label}…` };
            }
            const why =
                result.reason === "expired" ? "token expired — log in again" :
                    result.reason === "mismatch" ? "token belongs to another user" :
                        result.reason === "timeout" ? "switch timed out" :
                            "could not switch with this token";
            return { text: `${label}: ${why}.`, error: true };
        });
    }

    function handleRemove(account: PublicVaultAccount) {
        const label = account.globalName || account.username;
        openModal(props => (
            <ConfirmModal
                {...props}
                title="Remove account from vault?"
                confirmText="Remove from vault"
                cancelText="Cancel"
                variant="danger"
                onConfirm={() => void run(async () => {
                    await removeVaultAccount(account.id);
                    return { text: `${label} was removed from the vault (Discord session unchanged).` };
                })}
            >
                This only deletes the encrypted vault entry for <strong>{label}</strong>. It does not log the account out of Discord.
            </ConfirmModal>
        ));
    }

    function handleNote(account: PublicVaultAccount, note: string | null) {
        void run(async () => {
            await setVaultAccountNote(account.id, note);
            return { text: note ? `Label set to “${note}”.` : "Label cleared." };
        });
    }

    function handleChangePassword() {
        void run(async () => {
            if (newPassword !== newPasswordConfirm) throw new Error("The new passwords do not match.");
            await changeVaultPassword(currentPassword, newPassword);
            setCurrentPassword("");
            setNewPassword("");
            setNewPasswordConfirm("");
            setPassword("");
            return {
                text: "Vault password changed. All saved accounts were re-encrypted and the vault is unlocked."
            };
        });
    }

    function handleReset() {
        openModal(props => (
            <ConfirmModal
                {...props}
                title="Delete encrypted account vault?"
                confirmText="Delete vault"
                cancelText="Cancel"
                variant="danger"
                onConfirm={() => void run(async () => {
                    await deleteVault();
                    setPassword("");
                    setConfirmation("");
                    setImportPassword("");
                    setCurrentPassword("");
                    setNewPassword("");
                    setNewPasswordConfirm("");
                    return { text: "The local encrypted vault was deleted." };
                })}
            >
                Without the current password, the vault cannot be re-encrypted — this permanently deletes every encrypted account. Export a backup first if you might need these accounts later.
            </ConfirmModal>
        ));
    }

    const statusLabel = !snapshot.exists
        ? "Not configured"
        : snapshot.unlocked
            ? "Unlocked · automatic saving active"
            : "Locked · automatic saving paused";

    return (
        <section className="vc-moreAccounts-vault">
            <div className="vc-moreAccounts-vaultHeader">
                <div>
                    <Forms.FormTitle>Encrypted account vault</Forms.FormTitle>
                    <Forms.FormText>
                        Portable, password-protected backup for your account tokens. Tokens are never shown or exported as plain text.
                    </Forms.FormText>
                </div>
                <div className={`vc-moreAccounts-status ${snapshot.unlocked ? "vc-moreAccounts-statusUnlocked" : ""}`}>
                    <span />
                    {statusLabel}
                </div>
            </div>

            {!snapshot.exists && (
                <div className="vc-moreAccounts-panel">
                    <Forms.FormTitle tag="h5">Create a new vault</Forms.FormTitle>
                    <Forms.FormText className="vc-moreAccounts-helpText">
                        Use at least 12 characters. The password cannot be recovered because it is never stored.
                    </Forms.FormText>
                    <div className="vc-moreAccounts-passwordGrid">
                        <TextInput
                            type="password"
                            value={password}
                            onChange={setPassword}
                            placeholder="Vault password"
                            disabled={busy}
                        />
                        <TextInput
                            type="password"
                            value={confirmation}
                            onChange={setConfirmation}
                            placeholder="Confirm password"
                            disabled={busy}
                        />
                    </div>
                    <Flex className="vc-moreAccounts-actions">
                        <Button onClick={handleCreate} disabled={busy || !password || !confirmation}>
                            {busy ? "Working…" : "Create vault & save accounts"}
                        </Button>
                        <Button color={Button.Colors.TRANSPARENT} onClick={handleImport} disabled={busy || !password}>
                            Import encrypted backup
                        </Button>
                    </Flex>
                </div>
            )}

            {snapshot.exists && !snapshot.unlocked && (
                <div className="vc-moreAccounts-panel">
                    <Forms.FormTitle tag="h5">Unlock this vault</Forms.FormTitle>
                    <Forms.FormText className="vc-moreAccounts-helpText">
                        Unlock once after Discord starts. New logins and changed tokens are then saved automatically by user ID without duplicates.
                    </Forms.FormText>
                    <Flex className="vc-moreAccounts-unlockRow">
                        <TextInput
                            type="password"
                            value={password}
                            onChange={setPassword}
                            placeholder="Vault password"
                            disabled={busy}
                            onKeyDown={event => {
                                if (event.key === "Enter" && password) handleUnlock();
                            }}
                        />
                        <Button onClick={handleUnlock} disabled={busy || !password}>
                            {busy ? "Unlocking…" : "Unlock"}
                        </Button>
                    </Flex>
                    <div className="vc-moreAccounts-lockedMeta">
                        {snapshot.accountCount} encrypted account(s) · last updated {formatDate(snapshot.updatedAt)}
                    </div>
                </div>
            )}

            {snapshot.unlocked && (
                <>
                    <div className="vc-moreAccounts-toolbar">
                        <div>
                            <strong>{snapshot.accountCount} saved account{snapshot.accountCount === 1 ? "" : "s"}</strong>
                            <span>Last encrypted {formatDate(snapshot.updatedAt)}</span>
                        </div>
                        <Flex className="vc-moreAccounts-actions">
                            <Button onClick={handleSync} disabled={busy}>Save now</Button>
                            <Button onClick={() => handleRestore()} disabled={busy || snapshot.accountCount === 0}>
                                Restore all
                            </Button>
                            <Button
                                color={Button.Colors.TRANSPARENT}
                                onClick={handleCheckTokens}
                                disabled={busy || snapshot.accountCount === 0}
                            >
                                Check tokens
                            </Button>
                            <Button color={Button.Colors.TRANSPARENT} onClick={handleExport} disabled={busy}>
                                Export file
                            </Button>
                            <Button
                                color={Button.Colors.TRANSPARENT}
                                disabled={busy}
                                onClick={() => {
                                    lockVault();
                                    setMessage({ text: "Vault locked. Automatic saving is paused." });
                                }}
                            >
                                Lock
                            </Button>
                        </Flex>
                    </div>

                    <div className="vc-moreAccounts-accountList">
                        {snapshot.accounts.length === 0
                            ? <Forms.FormText>No accounts with a saved token are available yet.</Forms.FormText>
                            : snapshot.accounts.map(account => (
                                <AccountCard
                                    key={account.id}
                                    account={account}
                                    busy={busy}
                                    onRestore={selected => handleRestore([selected.id])}
                                    onSwitch={handleSwitch}
                                    onRemove={handleRemove}
                                    onNote={handleNote}
                                />
                            ))}
                    </div>

                    <div className="vc-moreAccounts-importPanel">
                        <div>
                            <strong>Merge another encrypted backup</strong>
                            <span>Accounts are matched by user ID; the newest token wins.</span>
                        </div>
                        <TextInput
                            type="password"
                            value={importPassword}
                            onChange={setImportPassword}
                            placeholder="Password of imported file"
                            disabled={busy}
                        />
                        <Button color={Button.Colors.TRANSPARENT} onClick={handleImport} disabled={busy || !importPassword}>
                            Choose file
                        </Button>
                    </div>
                </>
            )}

            {snapshot.exists && (
                <div className="vc-moreAccounts-panel">
                    <Forms.FormTitle tag="h5">Change vault password</Forms.FormTitle>
                    <Forms.FormText className="vc-moreAccounts-helpText">
                        To keep every saved account, enter the current password and a new one (min. 12 characters).
                        Without the current password, the only option is to delete the vault and start over.
                    </Forms.FormText>
                    <div className="vc-moreAccounts-passwordGrid vc-moreAccounts-passwordGridTriple">
                        <TextInput
                            type="password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                            placeholder="Current password"
                            disabled={busy}
                        />
                        <TextInput
                            type="password"
                            value={newPassword}
                            onChange={setNewPassword}
                            placeholder="New password"
                            disabled={busy}
                        />
                        <TextInput
                            type="password"
                            value={newPasswordConfirm}
                            onChange={setNewPasswordConfirm}
                            placeholder="Confirm new password"
                            disabled={busy}
                            onKeyDown={event => {
                                if (event.key === "Enter" && currentPassword && newPassword && newPasswordConfirm) {
                                    handleChangePassword();
                                }
                            }}
                        />
                    </div>
                    <Flex className="vc-moreAccounts-actions">
                        <Button
                            onClick={handleChangePassword}
                            disabled={busy || !currentPassword || !newPassword || !newPasswordConfirm}
                        >
                            {busy ? "Working…" : "Change password"}
                        </Button>
                        <Button
                            color={Button.Colors.RED}
                            onClick={handleReset}
                            disabled={busy}
                        >
                            Forgot password — delete vault
                        </Button>
                    </Flex>
                </div>
            )}

            {message && (
                <div className={`vc-moreAccounts-message ${message.error ? "vc-moreAccounts-messageError" : ""}`}>
                    {message.text}
                </div>
            )}

            <Forms.FormText className="vc-moreAccounts-securityNote">
                Security: AES-256-GCM · PBKDF2-SHA-256 (600,000 rounds) · random salt and nonce. Restoring an account switches the active Discord session and only works while its token is still valid.
            </Forms.FormText>
        </section>
    );
}
