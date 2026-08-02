'use client';

// Account page: how you get back in (GitHub, password, passkeys), the cloud
// backups this account owns, and the way out. Store *provisioning* stays in
// My Grinder → WiFi & Backup — this page manages what already exists.
//
// Everything reads as a list of facts with the action attached to the fact:
// no cards, no forms sitting open waiting to be used, no native disclosures.
import { Cloud, Ellipsis, KeyRound, LogIn, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ChangePasswordDialog } from '@/components/auth/change-password-dialog';
import { DeleteAccountDialog } from '@/components/auth/delete-account-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { RenameDialog } from '@/components/rename-dialog';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { authClient } from '@/lib/client/auth';
import * as ble from '@/lib/client/ble';
import {
    deleteStore,
    listMyStores,
    type OwnedStore,
    releaseStore,
    renameStore,
} from '@/lib/client/cloud';

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

function shortDate(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// The section owns the rule *below* it, so the gap above and below each
// hairline is the section's own padding — one number, symmetric, instead of the
// margin-plus-padding stack that left ~55px voids around every divider.
//
// `action` pairs with the title, not the title block: putting the description
// in the same flex row lets a long line wrap the button underneath it, where it
// reads as part of the prose.
function Section({
    title,
    description,
    action,
    children,
}: {
    title: string;
    description?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="border-b py-6 first:pt-0 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-4">
                <h2 className="min-w-0 font-medium text-base">{title}</h2>
                {action && <div className="shrink-0">{action}</div>}
            </div>
            {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
            <div className="mt-3">{children}</div>
        </section>
    );
}

// One line per fact: what it is on the left, its state on the right, the action
// last. The value belongs in a right-hand column rather than stacked under the
// name — stacked, every row was two lines of near-identical text with a wide
// empty gutter between it and the action, which is what made the page read as
// noise. Under `sm` there isn't room for three columns, so it stacks.
//
// Names are normal weight, not medium: at 14px medium they competed with the
// 16px medium section headings and flattened the hierarchy.
function Row({
    name,
    value,
    actions,
}: {
    name: ReactNode;
    value?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className="group flex items-center gap-4 border-b py-2.5 last:border-b-0">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <span className="min-w-0 truncate text-sm">{name}</span>
                {value && (
                    <span className="min-w-0 truncate text-muted-foreground text-sm sm:text-right">
                        {value}
                    </span>
                )}
            </div>
            {actions && (
                <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-70 sm:group-hover:opacity-100">
                    {actions}
                </div>
            )}
        </div>
    );
}

export function AccountPanel({ github }: { github: boolean }) {
    const router = useRouter();
    const { data: session, isPending } = authClient.useSession();
    const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
    const [passkeys, setPasskeys] = useState<PasskeyEntry[]>([]);
    const [stores, setStores] = useState<OwnedStore[]>([]);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const [busy, setBusy] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [deletingAccount, setDeletingAccount] = useState(false);
    const [passkeyToRemove, setPasskeyToRemove] = useState<PasskeyEntry | null>(null);
    const [storeToRename, setStoreToRename] = useState<OwnedStore | null>(null);
    const [storeToRelease, setStoreToRelease] = useState<OwnedStore | null>(null);
    const [storeToDelete, setStoreToDelete] = useState<OwnedStore | null>(null);

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

    // The session resolves on the client, so the first paint knows nothing.
    // Rows rather than a blank page: the shape of the answer is already known.
    if (isPending) {
        return (
            <>
                <PageHeader title="Account" />
                <div className="max-w-2xl space-y-3">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            </>
        );
    }

    if (!session?.user) {
        return (
            <>
                <PageHeader title="Account" />
                <div className="max-w-2xl">
                    <EmptyState
                        icon={UserRound}
                        title="Not signed in"
                        description="An account is what keeps your grinds backed up and readable from any browser."
                        action={
                            <Button nativeButton={false} render={<Link href="/signin" />}>
                                <LogIn />
                                Sign in
                            </Button>
                        }
                    />
                </div>
            </>
        );
    }

    const email = session.user.email;
    const hasPassword = accounts.some((a) => a.providerId === 'credential');
    const hasGithub = accounts.some((a) => a.providerId === 'github');
    // Anything that gets you in without the password. There is no email reset,
    // so with none of these a forgotten password locks the account for good.
    const hasRecovery = hasGithub || passkeys.length > 0;

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
        setStatus({ text: 'Passkey added.', kind: 'success' });
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
            // One grinder, one store, one name. Without this the sidebar kept
            // showing the label auto-generated from the BLE advertised name
            // ("GrindByWeight 2") while the backup carried the real one.
            if (store.device_id) ble.renameByDeviceId(store.device_id, name.trim());
            reload();
        } catch (error) {
            showError(error, 'Rename failed');
        }
    };

    const release = async (store: OwnedStore) => {
        try {
            await releaseStore(store.store_id);
            setStatus({ text: 'Grinder released.', kind: 'info' });
            reload();
        } catch (error) {
            showError(error, 'Release failed');
        }
    };

    const destroy = async (store: OwnedStore) => {
        try {
            await deleteStore(store.store_id);
            setStatus({ text: 'Backup deleted.', kind: 'info' });
            reload();
        } catch (error) {
            showError(error, 'Delete failed');
        }
    };

    const copyShareLink = async (store: OwnedStore) => {
        const { toast } = await import('sonner');
        try {
            await navigator.clipboard.writeText(shareLink(store));
            toast.success('Share link copied', {
                description: 'Anyone with it can read your grinds.',
            });
        } catch {
            setStatus({ text: `Share link: ${shareLink(store)}`, kind: 'info' });
        }
    };

    const signOut = async () => {
        await authClient.signOut();
        router.push('/');
        router.refresh();
    };

    return (
        <>
            {/* Header and body share one column, so Sign out lands on the same
                right edge as the row actions below it. */}
            <div className="max-w-2xl">
                <PageHeader
                    title="Account"
                    description={email}
                    actions={
                        <Button variant="outline" onClick={signOut}>
                            Sign out
                        </Button>
                    }
                />

                <StatusRegion status={status} />

                {/* Own wrapper so `first:` on Section is deterministic — with
                    the status region as a sibling it would move whenever a
                    message appeared. */}
                <div>
                    <Section
                        title="Signing in"
                        // Only shown when it is actually true. As a permanent
                        // subtitle it kept warning about lost access to an
                        // account that already had a passkey and GitHub linked.
                        description={
                            hasRecovery ? undefined : (
                                <span className="text-caution">
                                    There is no password reset — link GitHub or add a passkey so you
                                    have a way back in.
                                </span>
                            )
                        }
                    >
                        <Row
                            name="Password"
                            value={hasPassword ? 'In use' : 'Not set'}
                            actions={
                                hasPassword && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setChangingPassword(true)}
                                    >
                                        Change
                                    </Button>
                                )
                            }
                        />

                        {(github || hasGithub) && (
                            <Row
                                name="GitHub"
                                value={hasGithub ? 'Linked' : 'Not linked'}
                                actions={
                                    !hasGithub && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={linkGithub}
                                        >
                                            Link
                                        </Button>
                                    )
                                }
                            />
                        )}
                    </Section>

                    {/* Passkeys get their own section rather than more rows in
                        the list above: they are a collection you add to and
                        remove from, and a device name like "This Mac" says
                        nothing about what it is without a heading over it.
                        What a passkey *is* only needs explaining when there
                        are none — a list of your own devices explains itself. */}
                    <Section
                        title="Passkeys"
                        action={
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={addPasskey}
                            >
                                <KeyRound />
                                Add a passkey
                            </Button>
                        }
                    >
                        {passkeys.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                                None yet — add one to sign in with Touch ID or your phone instead of
                                a password.
                            </p>
                        ) : (
                            passkeys.map((entry) => {
                                const added = shortDate(entry.createdAt);
                                return (
                                    <Row
                                        key={entry.id}
                                        name={entry.name ?? 'Passkey'}
                                        value={added ? `Added ${added}` : undefined}
                                        actions={
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-muted-foreground hover:text-destructive"
                                                onClick={() => setPasskeyToRemove(entry)}
                                            >
                                                Remove
                                            </Button>
                                        }
                                    />
                                );
                            })
                        )}
                    </Section>

                    <Section title="Backups">
                        {stores.length === 0 ? (
                            <EmptyState
                                icon={Cloud}
                                title="No backups yet"
                                description="Your grinder creates one when you turn backup on, with the grinder nearby."
                                action={
                                    <Button
                                        variant="outline"
                                        nativeButton={false}
                                        render={<Link href="/grinder/wifi" />}
                                    >
                                        Set up backup
                                    </Button>
                                }
                            />
                        ) : (
                            stores.map((store) => {
                                const lastUpload = shortDate(store.last_received_at);
                                return (
                                    <Row
                                        key={store.store_id}
                                        name={
                                            <span className="flex items-center gap-2">
                                                <span className="truncate">
                                                    {store.name ?? store.store_id}
                                                </span>
                                                {!store.device_id && (
                                                    <Badge variant="outline">Archive</Badge>
                                                )}
                                            </span>
                                        }
                                        value={
                                            <>
                                                <span className="tabular-nums">
                                                    {store.session_count}
                                                </span>{' '}
                                                grinds
                                                {lastUpload && (
                                                    <>
                                                        {' · last upload '}
                                                        <span className="tabular-nums">
                                                            {lastUpload}
                                                        </span>
                                                    </>
                                                )}
                                            </>
                                        }
                                        actions={
                                            <>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => copyShareLink(store)}
                                                >
                                                    Copy link
                                                </Button>
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger
                                                        render={
                                                            <Button
                                                                variant="ghost"
                                                                size="icon-sm"
                                                                aria-label={`More actions for ${store.name ?? store.store_id}`}
                                                            >
                                                                <Ellipsis />
                                                            </Button>
                                                        }
                                                    />
                                                    <DropdownMenuContent
                                                        align="end"
                                                        className="w-56"
                                                    >
                                                        {/* The grinder id is a
                                                            lookup, not something
                                                            you scan a list by —
                                                            it belongs one click
                                                            away, not in the row. */}
                                                        {/* DropdownMenuLabel is
                                                            Base UI's GroupLabel:
                                                            it reads a context
                                                            only Group provides
                                                            and throws without
                                                            one, taking the page
                                                            down with it. */}
                                                        <DropdownMenuGroup>
                                                            {store.device_id && (
                                                                <DropdownMenuLabel className="font-mono font-normal text-muted-foreground text-xs">
                                                                    {store.device_id}
                                                                </DropdownMenuLabel>
                                                            )}
                                                            <DropdownMenuItem
                                                                onClick={() =>
                                                                    setStoreToRename(store)
                                                                }
                                                            >
                                                                Rename
                                                            </DropdownMenuItem>
                                                            {store.device_id && (
                                                                <DropdownMenuItem
                                                                    onClick={() =>
                                                                        setStoreToRelease(store)
                                                                    }
                                                                >
                                                                    Release grinder
                                                                </DropdownMenuItem>
                                                            )}
                                                        </DropdownMenuGroup>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            variant="destructive"
                                                            onClick={() => setStoreToDelete(store)}
                                                        >
                                                            Delete backup
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </>
                                        }
                                    />
                                );
                            })
                        )}
                    </Section>

                    <Section
                        title="Delete account"
                        description="Removes your account and every backup you own. Your grinders keep working."
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                            onClick={() => setDeletingAccount(true)}
                        >
                            Delete my account
                        </Button>
                    </Section>
                </div>
            </div>

            <ChangePasswordDialog
                open={changingPassword}
                onOpenChange={setChangingPassword}
                email={email}
                onChanged={(text) => setStatus({ text, kind: 'success' })}
                onError={(text) => setStatus({ text, kind: 'error' })}
            />

            <DeleteAccountDialog
                open={deletingAccount}
                onOpenChange={setDeletingAccount}
                hasPassword={hasPassword}
                storeCount={stores.length}
                onDeleted={() => {
                    router.push('/');
                    router.refresh();
                }}
                onError={(text) => setStatus({ text, kind: 'error' })}
            />

            <ConfirmDialog
                open={passkeyToRemove !== null}
                onOpenChange={(open) => !open && setPasskeyToRemove(null)}
                title={`Remove ${passkeyToRemove?.name ?? 'this passkey'}?`}
                description="That device can no longer sign you in."
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
                title="Rename backup"
                description="Also renames the grinder in the sidebar. Share links are unchanged."
                label="Name"
                initialValue={storeToRename?.name ?? ''}
                onSubmit={(name) => {
                    if (storeToRename) rename(storeToRename, name);
                    setStoreToRename(null);
                }}
            />

            <ConfirmDialog
                open={storeToRelease !== null}
                onOpenChange={(open) => !open && setStoreToRelease(null)}
                title="Release this grinder?"
                description="Its grinds stay here. The grinder stops uploading and starts fresh for its next owner."
                confirmLabel="Release grinder"
                onConfirm={() => {
                    if (storeToRelease) release(storeToRelease);
                    setStoreToRelease(null);
                }}
            />

            <ConfirmDialog
                open={storeToDelete !== null}
                onOpenChange={(open) => !open && setStoreToDelete(null)}
                title="Delete this backup?"
                description={`Permanently deletes ${storeToDelete?.session_count ?? 0} grinds. This cannot be undone.`}
                confirmLabel="Delete backup"
                destructive
                onConfirm={() => {
                    if (storeToDelete) destroy(storeToDelete);
                    setStoreToDelete(null);
                }}
            />
        </>
    );
}
