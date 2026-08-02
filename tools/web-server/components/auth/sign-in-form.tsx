'use client';

// Sign-in / sign-up: GitHub (when the deployment has an OAuth app),
// email/password, and passkey one-tap for accounts that registered one.
// There is deliberately no password reset — the stack has no mail service —
// so the copy pushes GitHub/passkeys as the recovery story.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { type StatusMessage, StatusRegion } from '@/components/status-region';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/client/auth';

export function SignInForm({ github }: { github: boolean }) {
    const router = useRouter();
    const { data: session, isPending } = authClient.useSession();
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<StatusMessage | null>(null);

    // Already signed in (e.g. back navigation): go home.
    useEffect(() => {
        if (!isPending && session?.user) router.replace('/');
    }, [isPending, session, router]);

    const finish = useCallback(() => {
        router.push('/');
        router.refresh();
    }, [router]);

    // Passkey conditional UI: browsers that support it offer this account's
    // passkeys straight from the email field's autofill dropdown (alongside
    // the password manager's saved logins). Needs the `webauthn` autocomplete
    // token in the DOM, so the ceremony starts after mount and is only armed
    // in sign-in mode.
    useEffect(() => {
        if (mode !== 'signin') return;
        let cancelled = false;
        (async () => {
            const supported = await window.PublicKeyCredential?.isConditionalMediationAvailable?.();
            if (!supported || cancelled) return;
            const result = await authClient.signIn.passkey({ autoFill: true });
            // Errors here are almost always "another ceremony took over" or a
            // dismissed prompt — never worth a visible message.
            if (!cancelled && result && !result.error) finish();
        })();
        return () => {
            cancelled = true;
        };
    }, [mode, finish]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!email.trim() || !password) {
            setStatus({ text: 'Enter your email and password.', kind: 'error' });
            return;
        }
        setBusy(true);
        setStatus(null);
        const { error } =
            mode === 'signup'
                ? await authClient.signUp.email({
                      email: email.trim(),
                      password,
                      // Better Auth requires a name; the local part is a fine
                      // default and editable later on the account page.
                      name: email.trim().split('@')[0] ?? email.trim(),
                  })
                : await authClient.signIn.email({ email: email.trim(), password });
        setBusy(false);
        if (error) {
            setStatus({ text: error.message ?? 'Sign-in failed.', kind: 'error' });
            return;
        }
        finish();
    };

    const signInGithub = async () => {
        setBusy(true);
        const { error } = await authClient.signIn.social({
            provider: 'github',
            callbackURL: '/',
        });
        // On success the browser navigates away; only errors land here.
        if (error) {
            setBusy(false);
            setStatus({ text: error.message ?? 'GitHub sign-in failed.', kind: 'error' });
        }
    };

    const signInPasskey = async () => {
        setBusy(true);
        setStatus(null);
        const result = await authClient.signIn.passkey();
        setBusy(false);
        if (result?.error) {
            setStatus({
                text: result.error.message ?? 'Passkey sign-in failed.',
                kind: 'error',
            });
            return;
        }
        finish();
    };

    return (
        <div className="mx-auto max-w-sm">
            <h1 className="font-semibold text-2xl tracking-tight">
                {mode === 'signup' ? 'Create your account' : 'Sign in'}
            </h1>

            <div className="grid gap-2">
                {github && (
                    <Button variant="outline" disabled={busy} onClick={signInGithub}>
                        Continue with GitHub
                    </Button>
                )}
                <Button variant="outline" disabled={busy} onClick={signInPasskey}>
                    Sign in with a passkey
                </Button>
            </div>

            <div className="my-6 flex items-center gap-3 text-muted-foreground text-xs">
                <span className="h-px flex-1 bg-border" />
                or use email
                <span className="h-px flex-1 bg-border" />
            </div>

            {/* Password managers key off the form's identity: `key={mode}`
                remounts the fields when switching sign-in ↔ sign-up so they
                re-read it as a login vs a registration form (and so offer to
                save a new password), and `name` attributes are what their
                heuristics match on — id alone is not enough. */}
            <form key={mode} name={mode} onSubmit={submit} className="grid gap-4">
                <div className="grid gap-2">
                    <Label htmlFor={`${mode}Email`}>Email</Label>
                    <Input
                        id={`${mode}Email`}
                        name="email"
                        type="email"
                        inputMode="email"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        autoComplete={mode === 'signup' ? 'username' : 'username webauthn'}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor={`${mode}Password`}>Password</Label>
                    <Input
                        id={`${mode}Password`}
                        name="password"
                        type="password"
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        minLength={8}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </div>
                <Button type="submit" disabled={busy}>
                    {mode === 'signup' ? 'Create account' : 'Sign in'}
                </Button>
            </form>

            <div className="mt-4">
                <StatusRegion status={status} />
            </div>

            <button
                type="button"
                className="mt-2 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => {
                    setMode(mode === 'signup' ? 'signin' : 'signup');
                    setStatus(null);
                }}
            >
                {mode === 'signup' ? 'I already have an account' : 'Create a new account instead'}
            </button>

            <p className="mt-8 border-t pt-6 text-muted-foreground text-xs">
                There is no password recovery — add a passkey or link GitHub after signing up.
            </p>
        </div>
    );
}
