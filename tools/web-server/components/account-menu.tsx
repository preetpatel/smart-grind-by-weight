'use client';

// Masthead account slot: a sign-in link for visitors, the account's email
// (linking to /account) once signed in. Session state is fetched client-side
// so the server layout stays static.
import Link from 'next/link';
import { authClient } from '@/lib/client/auth';

export function AccountMenu() {
    const { data: session, isPending } = authClient.useSession();

    if (isPending) return <span className="account-slot" />;

    if (!session?.user) {
        return (
            <span className="account-slot">
                <Link href="/signin" className="btn-ghost account-link">
                    Sign in
                </Link>
            </span>
        );
    }

    return (
        <span className="account-slot">
            <Link href="/account" className="btn-ghost account-link" title="Account settings">
                {session.user.email}
            </Link>
        </span>
    );
}
