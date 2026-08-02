'use client';

// Account page: sign-in methods (GitHub link, password, passkeys), the
// account's cloud stores, and account deletion. Store *provisioning* stays in
// My Grinder → WiFi & Sync — this page manages what already exists.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RenameDialog } from '@/components/rename-dialog';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    const [passkeyToRemove, setPasskeyToRemove] = useState<PasskeyEntry | null>(null);
    const [storeToRename, setStoreToRename] = useState<OwnedStore | null>(null);
    const [storeToDelete, setStoreToDelete] = useState<OwnedStore | null>(null);
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
            <div className="max-w-2xl">
                <h1 className="font-semibold text-2xl tracking-tight">Account</h1>
                <p className="mt-1 text-muted-foreground text-sm">
                    You&apos;re not signed in.{' '}
                    <Link
                        href="/signin"
                        className="underline underline-offset-4 hover:text-foreground"
                    >
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
        const result = await authClient.passkey.deletePasskey({ id: entry.id });
        if (result?.error) {
            setStatus({ text: result.error.message ?? 'Could not remove it.', kind: 'error' });
            return;
        }
        reload();
    };

    const rename = async (store: OwnedStore, name: string) => {
        try {
            await renameStore(store.store_id, name.trim());
            reload();
        } catch (error) {
            showError(error, 'Rename failed');
        }
    };

    const destroy = async (store: OwnedStore) => {
        try {
            await deleteStore(store.store_id);
            setStatus({ text: 'Store deleted.', kind: 'info' });
            reload();
        } catch (error) {
            showError(error, 'Delete failed');
        }
    };

    const copyShareLink = async (store: OwnedStore) => {
        const { toast } = await import('sonner');
        try {
            await navigator.clipboard.writeText(shareLink(store));
            toast.success('Dashboard link copied', {
                description: 'Anyone with it can read this store, but not change it.',
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
        <div className="max-w-2xl">
            <h1 className="font-semibold text-2xl tracking-tight">Account</h1>
            <p className="mt-1 text-muted-foreground text-sm">
                Signed in as <span className="text-foreground">{session.user.email}</span>
            </p>

            <div className="mt-5">
                <StatusRegion status={status} />
            </div>

            <section className="mt-8">
                <h2 className="font-medium text-base">Sign-in methods</h2>
                <p className="mt-1 mb-4 text-muted-foreground text-sm">
                    There is no password recovery here, so a linked GitHub account or a passkey is
                    your way back in.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    {github && !hasGithub && (
                        <Button variant="outline" size="sm" disabled={busy} onClick={linkGithub}>
                            Link GitHub
                        </Button>
                    )}
                    {hasGithub && <Badge variant="outline">GitHub linked</Badge>}
                    <Button variant="outline" size="sm" disabled={busy} onClick={addPasskey}>
                        Add a passkey
                    </Button>
                </div>
                {passkeys.length > 0 && (
                    <ul className="mt-4 border-t">
                        {passkeys.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-center justify-between gap-4 border-b py-2.5 text-sm"
                            >
                                <span>{entry.name ?? 'Passkey'}</span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() => setPasskeyToRemove(entry)}
                                >
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {hasPassword && (
                <section className="mt-10 border-t pt-8">
                    <h2 className="font-medium text-base">Change password</h2>
                    <form
                        name="changePassword"
                        onSubmit={changePassword}
                        className="mt-4 grid gap-4"
                    >
                        {/* A change-password form needs a username field for
                            password managers to know *which* saved login to
                            update; read-only, and it doubles as a reminder of
                            whose password is being changed. */}
                        <div className="grid gap-2">
                            <Label htmlFor="changePasswordAccount">Account</Label>
                            <Input
                                id="changePasswordAccount"
                                name="username"
                                type="text"
                                autoComplete="username"
                                readOnly
                                className="text-muted-foreground"
                                value={session.user.email}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="currentPassword">Current password</Label>
                            <Input
                                id="currentPassword"
                                name="current-password"
                                type="password"
                                autoComplete="current-password"
                                required
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="newPassword">New password</Label>
                            <Input
                                id="newPassword"
                                name="new-password"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                required
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                            />
                        </div>
                        <Button type="submit" variant="outline" className="w-fit" disabled={busy}>
                            Change password
                        </Button>
                    </form>
                </section>
            )}

            <section className="mt-10 border-t pt-8">
                <h2 className="font-medium text-base">Cloud stores</h2>
                {stores.length === 0 ? (
                    <p className="mt-1 text-muted-foreground text-sm">
                        No stores yet. Set one up from{' '}
                        <Link
                            href="/grinder/wifi"
                            className="underline underline-offset-4 hover:text-foreground"
                        >
                            WiFi &amp; Sync
                        </Link>{' '}
                        with your grinder nearby.
                    </p>
                ) : (
                    <ul className="mt-4 border-t">
                        {stores.map((store) => (
                            <li
                                key={store.store_id}
                                className="group flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-3"
                            >
                                <span className="min-w-0">
                                    <span className="block font-medium text-sm">
                                        {store.name ?? store.store_id}
                                    </span>
                                    <span className="block font-mono text-muted-foreground text-xs">
                                        {store.store_id} · {store.session_count} sessions
                                        {store.last_received_at
                                            ? ` · last upload ${new Date(store.last_received_at).toLocaleDateString()}`
                                            : ''}
                                    </span>
                                </span>
                                <span className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => copyShareLink(store)}
                                    >
                                        Copy link
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setStoreToRename(store)}
                                    >
                                        Rename
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={() => setStoreToDelete(store)}
                                    >
                                        Delete
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="mt-10 border-t pt-8">
                <Button variant="outline" size="sm" onClick={signOut}>
                    Sign out
                </Button>
            </section>

            <details className="mt-10 border-t pt-8">
                <summary className="cursor-pointer text-muted-foreground text-sm">
                    Delete account
                </summary>
                <form onSubmit={deleteAccount} className="mt-4 grid gap-4">
                    <p className="text-muted-foreground text-sm">
                        Deletes your account, every cloud store you own and all their sessions.
                        Grinders keep working locally; their uploads start failing until
                        re-provisioned.
                    </p>
                    <div className="grid gap-2">
                        <Label htmlFor="deleteConfirm">Type &quot;delete&quot; to confirm</Label>
                        <Input
                            id="deleteConfirm"
                            name="deleteConfirm"
                            type="text"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            className="max-w-xs"
                            value={deleteConfirm}
                            onChange={(e) => setDeleteConfirm(e.target.value)}
                        />
                    </div>
                    {hasPassword && (
                        <div className="grid gap-2">
                            <Label htmlFor="deletePassword">Your password</Label>
                            <Input
                                id="deletePassword"
                                name="password"
                                type="password"
                                autoComplete="current-password"
                                className="max-w-xs"
                                value={deletePassword}
                                onChange={(e) => setDeletePassword(e.target.value)}
                            />
                        </div>
                    )}
                    <Button type="submit" variant="destructive" className="w-fit" disabled={busy}>
                        Delete my account
                    </Button>
                </form>
            </details>

            <ConfirmDialog
                open={passkeyToRemove !== null}
                onOpenChange={(open) => !open && setPasskeyToRemove(null)}
                title={`Remove ${passkeyToRemove?.name ?? 'this passkey'}?`}
                description="That device can no longer sign you in. Any other passkeys, your password and a linked GitHub account keep working."
                confirmLabel="Remove"
                destructive
                onConfirm={() => {
                    if (passkeyToRemove) removePasskey(passkeyToRemove);
                    setPasskeyToRemove(null);
                }}
            />

            <RenameDialog
                open={storeToRename !== null}
                onOpenChange={(open) => !open && setStoreToRename(null)}
                title="Rename store"
                description="Only a label for you — the store id and its share links are unchanged."
                label="Store name"
                initialValue={storeToRename?.name ?? ''}
                onSubmit={(name) => {
                    if (storeToRename) rename(storeToRename, name);
                    setStoreToRename(null);
                }}
            />

            <ConfirmDialog
                open={storeToDelete !== null}
                onOpenChange={(open) => !open && setStoreToDelete(null)}
                title="Delete this store?"
                description={`Permanently removes ${storeToDelete?.session_count ?? 0} sessions and breaks every share link to it. Any grinder uploading here will start failing until re-provisioned. This cannot be undone.`}
                confirmLabel="Delete store"
                destructive
                onConfirm={() => {
                    if (storeToDelete) destroy(storeToDelete);
                    setStoreToDelete(null);
                }}
            />
        </div>
    );
}
