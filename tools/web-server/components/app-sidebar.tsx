'use client';

// The app shell's left rail. The grinder is the workspace switcher at the top
// — the device is the thing every section is *about* — and the account sits at
// the bottom. Nav items carry their own state (an update badge, a warning dot)
// so the terse status strip the header used to need is gone: each fact now
// lives on the page that can act on it.
import {
    Activity,
    ChevronsUpDown,
    GitCompare,
    House,
    Layers,
    ListFilter,
    LogIn,
    Plus,
    RefreshCw,
    Stethoscope,
    TrendingUp,
    Usb,
    User,
    Wifi,
    Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { authClient } from '@/lib/client/auth';
import * as ble from '@/lib/client/ble';
import { compareVersions, fetchReleases, latestStable } from '@/lib/client/releases';
import { useGrinder } from '@/lib/client/use-grinder';

const GRINDER_NAV = [
    { href: '/', label: 'Home', icon: House },
    { href: '/grinder/get-started', label: 'Install', icon: Usb },
    { href: '/grinder/update', label: 'Update', icon: Zap },
    { href: '/grinder/wifi', label: 'WiFi & Backup', icon: Wifi },
    { href: '/grinder/diagnostics', label: 'Diagnostics', icon: Stethoscope },
] as const;

const ANALYTICS_NAV = [
    { href: '/analytics', label: 'Overview', icon: Activity },
    { href: '/analytics/sessions', label: 'Grinds', icon: ListFilter },
    { href: '/analytics/compare', label: 'Compare', icon: GitCompare },
    { href: '/analytics/multi', label: 'Aggregate', icon: Layers },
    { href: '/analytics/trends', label: 'Trends', icon: TrendingUp },
    { href: '/analytics/health', label: 'Health', icon: Stethoscope },
] as const;

function ConnectionDot({ connected }: { connected: boolean }) {
    return (
        <span
            aria-hidden
            className={
                connected
                    ? 'size-2 shrink-0 rounded-full bg-success'
                    : 'size-2 shrink-0 rounded-full border border-muted-foreground'
            }
        />
    );
}

function GrinderSwitcher() {
    const { supported, connected, active, grinders } = useGrinder();
    const [busy, setBusy] = useState(false);
    const [confirmForget, setConfirmForget] = useState(false);
    const refreshed = useRef(false);

    // Silent background refresh of the active grinder (no chooser), quiet on
    // failure — grinder asleep, or a browser without getDevices().
    useEffect(() => {
        if (!refreshed.current && supported && active) {
            refreshed.current = true;
            ble.refreshSnapshot({ interactive: false }).catch(() => {});
        }
    }, [supported, active]);

    const run = async (fn: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        try {
            await fn();
        } catch (error) {
            // A dismissed chooser is a decision, not a failure.
            if ((error as Error).name !== 'NotFoundError') {
                const { toast } = await import('sonner');
                toast.error((error as Error).message);
            }
        } finally {
            setBusy(false);
        }
    };

    if (!supported) {
        return (
            <SidebarMenuButton size="lg" disabled className="gap-2.5">
                <ConnectionDot connected={false} />
                <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-medium">No Bluetooth</span>
                    <span className="truncate text-muted-foreground text-xs">
                        needs Chrome or Edge
                    </span>
                </span>
            </SidebarMenuButton>
        );
    }

    if (!active) {
        return (
            <SidebarMenuButton
                size="lg"
                disabled={busy}
                onClick={() => run(() => ble.addGrinder())}
                className="gap-2.5"
            >
                <ConnectionDot connected={false} />
                <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-medium">Connect a grinder</span>
                </span>
            </SidebarMenuButton>
        );
    }

    const version =
        typeof active.snapshot?.system?.version === 'string'
            ? active.snapshot.system.version
            : null;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <SidebarMenuButton size="lg" className="gap-2.5">
                            <ConnectionDot connected={connected} />
                            <span className="grid flex-1 text-left leading-tight">
                                <span className="truncate font-medium">{active.label}</span>
                                <span className="truncate font-mono text-muted-foreground text-xs">
                                    {version ? `v${version}` : 'not read yet'}
                                    {connected ? ' · connected' : ''}
                                </span>
                            </span>
                            <ChevronsUpDown className="ml-auto size-4 opacity-60" />
                        </SidebarMenuButton>
                    }
                />
                <DropdownMenuContent align="start" className="w-60">
                    {grinders.length > 1 && (
                        <>
                            {grinders.map((grinder) => (
                                <DropdownMenuItem
                                    key={grinder.id}
                                    onClick={() => ble.setActive(grinder.id)}
                                >
                                    <ConnectionDot
                                        connected={grinder.id === active.id && connected}
                                    />
                                    {grinder.label}
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <DropdownMenuItem
                        disabled={busy}
                        onClick={() => run(() => ble.refreshSnapshot({ interactive: true }))}
                    >
                        <RefreshCw />
                        Refresh
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => run(() => ble.addGrinder())}>
                        <Plus />
                        Add grinder
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmForget(true)}>
                        Forget
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <ConfirmDialog
                open={confirmForget}
                onOpenChange={setConfirmForget}
                title={`Forget ${active.label}?`}
                description="Removes it from this browser only — the grinder keeps everything."
                confirmLabel="Forget"
                destructive
                onConfirm={() => ble.forget(active.id)}
            />
        </>
    );
}

function AccountButton() {
    const { data: session, isPending } = authClient.useSession();

    if (isPending) {
        return (
            <SidebarMenuButton disabled className="text-muted-foreground">
                Account
            </SidebarMenuButton>
        );
    }
    if (!session?.user) {
        return (
            <SidebarMenuButton render={<Link href="/signin" />}>
                <LogIn />
                Sign in
            </SidebarMenuButton>
        );
    }
    return (
        <SidebarMenuButton render={<Link href="/account" />}>
            <User />
            <span className="truncate">{session.user.email}</span>
        </SidebarMenuButton>
    );
}

export function AppSidebar() {
    const pathname = usePathname();
    const { active } = useGrinder();
    const [latestVersion, setLatestVersion] = useState<string | null>(null);

    useEffect(() => {
        fetchReleases()
            .then((entries) => setLatestVersion(latestStable(entries)?.version ?? null))
            .catch(() => {});
    }, []);

    const version =
        typeof active?.snapshot?.system?.version === 'string'
            ? active.snapshot.system.version
            : null;
    const updateAvailable = Boolean(
        latestVersion && version && compareVersions(latestVersion, version) > 0,
    );
    const loggingOff = active?.snapshot?.sessions?.logging_enabled === false;

    const isActive = (href: string) =>
        href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <GrinderSwitcher />
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Grinder</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {GRINDER_NAV.map((item) => (
                                <SidebarMenuItem key={item.href}>
                                    <SidebarMenuButton
                                        isActive={isActive(item.href)}
                                        tooltip={item.label}
                                        render={<Link href={item.href} />}
                                    >
                                        <item.icon />
                                        {item.label}
                                    </SidebarMenuButton>
                                    {item.href === '/grinder/update' && updateAvailable && (
                                        <SidebarMenuBadge className="text-caution">
                                            new
                                        </SidebarMenuBadge>
                                    )}
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>

                <SidebarGroup>
                    <SidebarGroupLabel>Analytics</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {ANALYTICS_NAV.map((item) => (
                                <SidebarMenuItem key={item.href}>
                                    <SidebarMenuButton
                                        isActive={
                                            item.href === '/analytics'
                                                ? pathname === '/analytics'
                                                : isActive(item.href)
                                        }
                                        tooltip={item.label}
                                        render={<Link href={item.href} />}
                                    >
                                        <item.icon />
                                        {item.label}
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter>
                {loggingOff && (
                    <Badge
                        variant="outline"
                        className="justify-start border-caution/40 text-caution group-data-[collapsible=icon]:hidden"
                    >
                        Logging off
                    </Badge>
                )}
                <SidebarMenu>
                    <SidebarMenuItem>
                        <AccountButton />
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    );
}
