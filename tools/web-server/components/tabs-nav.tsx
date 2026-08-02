'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
    { href: '/', label: 'My Grinder' },
    { href: '/analytics', label: 'Analytics' },
] as const;

export function TabsNav() {
    const pathname = usePathname();
    return (
        <div className="tabs">
            {TABS.map((tab) => (
                <Link
                    key={tab.href}
                    href={tab.href}
                    className={`tab ${pathname === tab.href ? 'active' : ''}`}
                >
                    {tab.label}
                </Link>
            ))}
        </div>
    );
}
