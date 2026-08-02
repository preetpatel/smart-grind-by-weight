import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

// The signed-in shell: sidebar rail, collapse trigger, page canvas. Everything
// under (app) is about a grinder you already have, so the rail is always the
// right frame. /signin sits in (auth) instead, where none of it applies.
export default function AppLayout({ children }: { children: React.ReactNode }) {
    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <header className="flex h-12 shrink-0 items-center border-b px-4">
                    <SidebarTrigger className="-ml-1.5" />
                </header>
                <div className="min-w-0 flex-1 px-6 py-6">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
