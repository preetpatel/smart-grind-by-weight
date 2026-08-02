'use client';

// Sign-in / sign-up: GitHub (when the deployment has an OAuth app),
// email/password, and passkey one-tap for accounts that registered one.
// There is deliberately no password reset — the stack has no mail service —
// so the copy pushes GitHub/passkeys as the recovery story.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StatusBox, type StatusMessage } from '@/components/ui';
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

    const finish = () => {
        router.push('/');
        router.refresh();
    };

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
        <div className="form-stack">
            <h2>{mode === 'signup' ? 'Create your account' : 'Sign in'}</h2>
            <p className="lede-line">
                Your account keeps your grinder&apos;s cloud backups and dashboards available from
                any browser.
            </p>

            <div className="btn-row">
                {github && (
                    <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy}
                        onClick={signInGithub}
                    >
                        Continue with GitHub
                    </button>
                )}
                <button type="button" className="btn-ghost" disabled={busy} onClick={signInPasskey}>
                    Sign in with a passkey
                </button>
            </div>

            <div className="auth-divider">or use email</div>

            <form onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor="authEmail">Email</label>
                    <input
                        id="authEmail"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="authPassword">Password</label>
                    <input
                        id="authPassword"
                        type="password"
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </div>
                <div className="btn-row">
                    <button type="submit" className="btn btn-accent" disabled={busy}>
                        {mode === 'signup' ? 'Create account' : 'Sign in'}
                    </button>
                    <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                            setMode(mode === 'signup' ? 'signin' : 'signup');
                            setStatus(null);
                        }}
                    >
                        {mode === 'signup'
                            ? 'I already have an account'
                            : 'Create a new account instead'}
                    </button>
                </div>
            </form>

            <StatusBox status={status} />

            <p className="next-step">
                There is no password recovery on this server — after signing up, link GitHub or add
                a passkey on the Account page as your backup way in.
            </p>
        </div>
    );
}
