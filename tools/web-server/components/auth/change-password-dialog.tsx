'use client';

// Changing a password is a once-a-year act, so it lives behind a dialog rather
// than sitting expanded on the account page forever. Kept out of
// components/ui: this is auth-specific form logic, not a primitive.
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

export function ChangePasswordDialog({
    open,
    onOpenChange,
    email,
    onChanged,
    onError,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    email: string;
    onChanged: (message: string) => void;
    onError: (message: string) => void;
}) {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [busy, setBusy] = useState(false);

    const close = () => {
        setCurrentPassword('');
        setNewPassword('');
        onOpenChange(false);
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const { error } = await authClient.changePassword({
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
        });
        setBusy(false);
        if (error) {
            onError(error.message ?? 'Password change failed.');
            return;
        }
        close();
        onChanged('Password changed. Other sessions were signed out.');
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="sm:max-w-sm">
                <form name="changePassword" onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>Change password</DialogTitle>
                        <DialogDescription>
                            Every other signed-in browser is signed out.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="my-5 grid gap-4">
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
                                value={email}
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
                                autoFocus
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
                    </div>

                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                        <Button type="submit" disabled={busy}>
                            {busy ? 'Changing…' : 'Change password'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
