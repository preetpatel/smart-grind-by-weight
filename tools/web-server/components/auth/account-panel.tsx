'use client';

// Account page: sign-in methods (GitHub link, password, passkeys), the
// account's cloud stores, and account deletion. Store *provisioning* stays in
// My Grinder → WiFi & Sync — this page manages what already exists.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { StatusBox, type StatusMessage } from '@/components/ui';
import { authClient } from '@/lib/client/auth';
import { deleteStore, listMyStores, type OwnedStore, renameStore } from '@/lib/client/cloud';

interface LinkedAccount {
    providerId: string;
    accountId: string;
}

interface PasskeyEntry {
    id: string;
    name?: string | null;
    createdAt?: Date | string;
}

function shareLink(store: OwnedStore): string {
    return `${location.origin}/analytics#store=${store.store_id}:${store.view_key}`;
}

export function AccountPanel({ github }: { github: boolean }) {
    const router = useRouter();
    const { data: session, isPending } = authClient.useSession();
    const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
    const [passkeys, setPasskeys] = useState<PasskeyEntry[]>([]);
    const [stores, setStores] = useState<OwnedStore[]>([]);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [busy, setBusy] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState('');
    const [deletePassword, setDeletePassword] = useState('');

    const showError = (error: unknown, prefix: string) =>
        setStatus({
            text: `${prefix}: ${error instanceof Error ? error.message : error}`,
            kind: 'error',
        });

    const reload = useCallback(async () => {
        const [accountsResult, passkeysResult, storesResult] = await Promise.allSettled([
            authClient.listAccounts(),
            authClient.passkey.listUserPasskeys(),
            listMyStores(),
        ]);
        if (accountsResult.status === 'fulfilled' && accountsResult.value.data) {
            setAccounts(accountsResult.value.data);
        }
        if (passkeysResult.status === 'fulfilled' && passkeysResult.value.data) {
            setPasskeys(passkeysResult.value.data);
        }
        if (storesResult.status === 'fulfilled') setStores(storesResult.value);
    }, []);

    useEffect(() => {
        if (session?.user) reload();
    }, [session, reload]);

    if (isPending) return null;
    if (!session?.user) {
        return (
            <div className="form-stack">
                <h2>Account</h2>
                <p className="lede-line">
                    You&apos;re not signed in.{' '}
                    <Link href="/signin" className="link-inline">
                        Sign in
                    </Link>{' '}
                    to manage your cloud stores and sign-in methods.
                </p>
            </div>
        );
    }

    const hasPassword = accounts.some((a) => a.providerId === 'credential');
    const hasGithub = accounts.some((a) => a.providerId === 'github');

    const changePassword = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const { error } = await authClient.changePassword({
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
        });
        setBusy(false);
        if (error) {
            setStatus({ text: error.message ?? 'Password change failed.', kind: 'error' });
            return;
        }
        setCurrentPassword('');
        setNewPassword('');
        setStatus({ text: 'Password changed. Other sessions were signed out.', kind: 'success' });
    };

    const linkGithub = async () => {
        setBusy(true);
        const { error } = await authClient.linkSocial({
            provider: 'github',
            callbackURL: '/account',
        });
        if (error) {
            setBusy(false);
            setStatus({ text: error.message ?? 'GitHub linking failed.', kind: 'error' });
        }
    };

    const addPasskey = async () => {
        setBusy(true);
        const result = await authClient.passkey.addPasskey({
            name: navigator.userAgent.includes('Mac') ? 'This Mac' : 'This device',
        });
        setBusy(false);
        if (result?.error) {
            setStatus({ text: result.error.message ?? 'Could not add a passkey.', kind: 'error' });
            return;
        }
        setStatus({ text: 'Passkey added — use it for one-tap sign-in.', kind: 'success' });
        reload();
    };

    const removePasskey = async (entry: PasskeyEntry) => {
        if (!window.confirm(`Remove passkey "${entry.name ?? entry.id}"?`)) return;
        const result = await authClient.passkey.deletePasskey({ id: entry.id });
        if (result?.error) {
            setStatus({ text: result.error.message ?? 'Could not remove it.', kind: 'error' });
            return;
        }
        reload();
    };

    const rename = async (store: OwnedStore) => {
        const name = window.prompt('Store name', store.name ?? '');
        if (!name?.trim()) return;
        try {
            await renameStore(store.store_id, name.trim());
            reload();
        } catch (error) {
            showError(error, 'Rename failed');
        }
    };

    const destroy = async (store: OwnedStore) => {
        if (
            !window.confirm(
                `Permanently delete store ${store.store_id} and its ${store.session_count} sessions?`,
            )
        ) {
            return;
        }
        try {
            await deleteStore(store.store_id);
            setStatus({ text: 'Store deleted.', kind: 'info' });
            reload();
        } catch (error) {
            showError(error, 'Delete failed');
        }
    };

    const copyShareLink = async (store: OwnedStore) => {
        try {
            await navigator.clipboard.writeText(shareLink(store));
            setStatus({
                text: 'Dashboard link copied — anyone with it can view (not modify) this store.',
                kind: 'success',
            });
        } catch {
            setStatus({ text: `Dashboard link: ${shareLink(store)}`, kind: 'info' });
        }
    };

    const signOut = async () => {
        await authClient.signOut();
        router.push('/');
        router.refresh();
    };

    const deleteAccount = async (event: React.FormEvent) => {
        event.preventDefault();
        if (deleteConfirm !== 'delete') {
            setStatus({ text: 'Type "delete" to confirm account deletion.', kind: 'error' });
            return;
        }
        setBusy(true);
        const { error } = await authClient.deleteUser(
            hasPassword ? { password: deletePassword } : {},
        );
        setBusy(false);
        if (error) {
            setStatus({ text: error.message ?? 'Account deletion failed.', kind: 'error' });
            return;
        }
        router.push('/');
        router.refresh();
    };

    return (
        <div className="form-stack">
            <h2>Account</h2>
            <p className="lede-line">
                Signed in as <b>{session.user.email}</b>
            </p>

            <StatusBox status={status} />

            <h3>Sign-in methods</h3>
            <div className="btn-row">
                {github && !hasGithub && (
                    <button
                        type="button"
                        className="btn-ghost"
                        disabled={busy}
                        onClick={linkGithub}
                    >
                        Link GitHub
                    </button>
                )}
                {hasGithub && <span className="g-chip update">GitHub linked</span>}
                <button type="button" className="btn-ghost" disabled={busy} onClick={addPasskey}>
                    Add a passkey
                </button>
            </div>
            {passkeys.length > 0 && (
                <ul className="account-list">
                    {passkeys.map((entry) => (
                        <li key={entry.id}>
                            <span>{entry.name ?? 'Passkey'}</span>
                            <button
                                type="button"
                                className="btn-ghost danger"
                                onClick={() => removePasskey(entry)}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {hasPassword && (
                <form onSubmit={changePassword}>
                    <h3>Change password</h3>
                    <div className="form-group">
                        <label htmlFor="currentPassword">Current password</label>
                        <input
                            id="currentPassword"
                            type="password"
                            autoComplete="current-password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="newPassword">New password</label>
                        <input
                            id="newPassword"
                            type="password"
                            autoComplete="new-password"
                            minLength={8}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                        />
                    </div>
                    <button type="submit" className="btn-ghost" disabled={busy}>
                        Change password
                    </button>
                </form>
            )}

            <h3>Cloud stores</h3>
            {stores.length === 0 ? (
                <p className="lede-line">
                    No stores yet. Set up cloud backup from{' '}
                    <Link href="/" className="link-inline">
                        My Grinder → WiFi &amp; Sync
                    </Link>{' '}
                    with your grinder nearby.
                </p>
            ) : (
                <ul className="account-list">
                    {stores.map((store) => (
                        <li key={store.store_id}>
                            <span>
                                <b>{store.name ?? store.store_id}</b>
                                <span className="store-line">
                                    {' '}
                                    {store.store_id} · {store.session_count} sessions
                                    {store.last_received_at
                                        ? ` · last upload ${new Date(store.last_received_at).toLocaleDateString()}`
                                        : ''}
                                </span>
                            </span>
                            <span className="account-list-actions">
                                <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() => copyShareLink(store)}
                                >
                                    Copy link
                                </button>
                                <button
                                    type="button"
                                    className="btn-ghost"
                                    onClick={() => rename(store)}
                                >
                                    Rename
                                </button>
                                <button
                                    type="button"
                                    className="btn-ghost danger"
                                    onClick={() => destroy(store)}
                                >
                                    Delete
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <h3>Session</h3>
            <div className="btn-row">
                <button type="button" className="btn-ghost" onClick={signOut}>
                    Sign out
                </button>
            </div>

            <details>
                <summary>Delete account</summary>
                <form onSubmit={deleteAccount}>
                    <p className="lede-line">
                        Deletes your account, every cloud store you own and all their sessions.
                        Grinders keep working locally; their cloud uploads will start failing until
                        re-provisioned.
                    </p>
                    <div className="form-group">
                        <label htmlFor="deleteConfirm">Type &quot;delete&quot; to confirm</label>
                        <input
                            id="deleteConfirm"
                            type="text"
                            autoComplete="off"
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                        />
                    </div>
                    {hasPassword && (
                        <div className="form-group">
                            <label htmlFor="deletePassword">Your password</label>
                            <input
                                id="deletePassword"
                                type="password"
                                autoComplete="current-password"
                                value={deletePassword}
                                onChange={(e) => setDeletePassword(e.target.value)}
                            />
                        </div>
                    )}
                    <button type="submit" className="btn-ghost danger" disabled={busy}>
                        Delete my account
                    </button>
                </form>
            </details>
        </div>
    );
}
