import { connection } from 'next/server';
import { AccountPanel } from '@/components/auth/account-panel';

// Server wrapper so the GitHub-linking flag comes from runtime env.
export default async function AccountPage() {
    await connection();
    const github = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    return <AccountPanel github={github} />;
}
