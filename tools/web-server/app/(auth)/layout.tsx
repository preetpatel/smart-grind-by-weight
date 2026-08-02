import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

// Signed out, the sidebar is a list of things you can't do yet — so auth gets
// its own frame: one centred column and a way back to the front door. No card
// around it; the empty page is the boundary.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
            <div className="w-full max-w-sm">
                <Link
                    href="/"
                    className="group mb-10 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
                >
                    <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
                    Smart Grind by Weight
                </Link>
                {children}
            </div>
        </div>
    );
}
