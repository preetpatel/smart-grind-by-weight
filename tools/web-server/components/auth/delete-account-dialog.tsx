'use client';

// Account deletion asks for the typed word *and* the password, because it
// takes every backup with it. Behind a dialog rather than a <details> block:
// an irreversible form shouldn't be one stray click from being submitted.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/client/auth';

const CONFIRM_WORD = 'delete';

export function DeleteAccountDialog({
    open,
    onOpenChange,
    hasPassword,
    storeCount,
    onDeleted,
    onError,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    hasPassword: boolean;
    storeCount: number;
    onDeleted: () => void;
    onError: (message: string) => void;
}) {
    const [confirmWord, setConfirmWord] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);

    const close = () => {
        setConfirmWord('');
        setPassword('');
        onOpenChange(false);
    };

    const ready = confirmWord.trim().toLowerCase() === CONFIRM_WORD && (!hasPassword || password);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        setBusy(true);
        const { error } = await authClient.deleteUser(hasPassword ? { password } : {});
        setBusy(false);
        if (error) {
            onError(error.message ?? 'Account deletion failed.');
            return;
        }
        close();
        onDeleted();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="sm:max-w-sm">
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>Delete your account?</DialogTitle>
                        <DialogDescription>
                            {storeCount > 0
                                ? `This also deletes ${storeCount === 1 ? 'the backup' : `all ${storeCount} backups`} you own, and every grind in ${storeCount === 1 ? 'it' : 'them'}. Your grinders keep working.`
                                : 'Your grinders keep working. This cannot be undone.'}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="my-5 grid gap-4">
                        <div className="grid gap-2">
                            <Label htmlFor="deleteConfirm">
                                Type <span className="font-mono">{CONFIRM_WORD}</span> to confirm
                            </Label>
                            <Input
                                id="deleteConfirm"
                                name="deleteConfirm"
                                type="text"
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                data-1p-ignore
                                data-lpignore="true"
                                autoFocus
                                className="font-mono"
                                value={confirmWord}
                                onChange={(e) => setConfirmWord(e.target.value)}
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
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>
                            Keep my account
                        </DialogClose>
                        <Button type="submit" variant="destructive" disabled={!ready || busy}>
                            {busy ? 'Deleting…' : 'Delete account'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
