import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
// The pre-shadcn stylesheet, still driving the surfaces that have not been
// migrated yet. Unlayered, so it wins over Tailwind's @layer base reset.
import './legacy.css';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        // Dark-only for now; the preset's light block stays in globals.css so
        // adding a toggle later is purely additive.
        <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark antialiased`}>
            <body>
                <SidebarProvider>
                    <AppSidebar />
                    <SidebarInset>
                        <header className="flex h-12 shrink-0 items-center border-b px-4">
                            <SidebarTrigger className="-ml-1.5" />
                        </header>
                        <div className="min-w-0 flex-1 px-6 py-6">{children}</div>
                    </SidebarInset>
                </SidebarProvider>
                <Toaster />
            </body>
        </html>
    );
}
