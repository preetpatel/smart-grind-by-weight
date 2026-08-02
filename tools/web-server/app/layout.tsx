import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';

// Variable names must match what the preset's `@theme inline` block reads:
// --font-sans and --font-geist-mono. create-next-app emits --font-geist-sans,
// which leaves --font-sans self-referential and silently unstyled.
const geistSans = Geist({
    variable: '--font-sans',
    subsets: ['latin'],
});

const geistMono = Geist_Mono({
    variable: '--font-geist-mono',
    subsets: ['latin'],
});

export const metadata: Metadata = {
    title: 'Smart Grind by Weight — Flasher & Analytics',
    description:
        'Firmware, diagnostics and grind telemetry for the Smart Grind by Weight scale, over Web Bluetooth.',
};

// Document shell only. The two route groups own their own chrome: (app) puts
// the sidebar around every grinder and analytics route, (auth) centres a
// signed-out visitor on the one thing they came to do.
export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        // Dark-only for now; the preset's light block stays in globals.css so
        // adding a toggle later is purely additive.
        <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark antialiased`}>
            <body>
                {children}
                <Toaster />
            </body>
        </html>
    );
}
