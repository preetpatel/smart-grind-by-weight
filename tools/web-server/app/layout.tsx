import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
// The pre-shadcn stylesheet, still driving every screen until each surface is
// migrated. Unlayered, so it wins over Tailwind's @layer base reset.
import './legacy.css';
import { AccountMenu } from '@/components/account-menu';
import { DeviceStrip } from '@/components/device-strip';
import { TabsNav } from '@/components/tabs-nav';

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
        <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
            <body>
                <div className="shell">
                    <header className="masthead">
                        <h1>
                            <span className="mark" />
                            Smart Grind <span className="dim">by Weight</span>
                        </h1>
                        <div className="lede">
                            firmware · diagnostics · grind telemetry, over Web Bluetooth
                        </div>
                        <AccountMenu />
                    </header>

                    <DeviceStrip />
                    <TabsNav />
                    {children}
                </div>
            </body>
        </html>
    );
}
