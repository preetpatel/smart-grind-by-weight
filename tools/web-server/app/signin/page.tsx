import { connection } from 'next/server';
import { SignInForm } from '@/components/auth/sign-in-form';

// Server wrapper so the GitHub-button flag comes from runtime env (self-host
// docker images are built without deployment env vars).
export default async function SignInPage() {
    await connection();
    const github = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    return <SignInForm github={github} />;
}
