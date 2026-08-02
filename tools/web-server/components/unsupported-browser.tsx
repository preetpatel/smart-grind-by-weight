'use client';

// Every device flow needs Web Bluetooth (and USB install needs Web Serial),
// which rules out Firefox and every iOS browser. Rendered after mount so the
// static HTML never claims support the browser doesn't have.
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { isSupported } from '@/lib/client/ble';

export function UnsupportedBrowser() {
    const [supported, setSupported] = useState(true);

    useEffect(() => setSupported(isSupported()), []);

    if (supported) return null;

    return (
        <Alert variant="destructive" className="mb-6">
            <TriangleAlert />
            <AlertTitle>This browser can&apos;t reach the grinder</AlertTitle>
            <AlertDescription>
                Connecting needs Web Bluetooth — available in Chrome and Edge on desktop and
                Android. Firefox and every iOS browser are out. You can still read a shared
                dashboard link here.
            </AlertDescription>
        </Alert>
    );
}
