import type { Metadata } from 'next';
import './globals.css';
import { DeviceStrip } from '@/components/device-strip';
import { TabsNav } from '@/components/tabs-nav';

export const metadata: Metadata = {
    title: 'Smart Grind by Weight — Flasher & Analytics',
    description:
        'Firmware, diagnostics and grind telemetry for the Smart Grind by Weight scale, over Web Bluetooth.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
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
                    </header>

                    <DeviceStrip />
                    <TabsNav />
                    {children}
                </div>
            </body>
        </html>
    );
}
