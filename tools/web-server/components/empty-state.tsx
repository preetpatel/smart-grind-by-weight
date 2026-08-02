// A dead end should say what happened, why, and what to do next — in that
// order — rather than leaving a blank page or an info box that only restates
// the obvious.
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
}: {
    icon?: LucideIcon;
    title: string;
    description?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed px-6 py-10">
            {Icon && <Icon className="size-5 text-muted-foreground" />}
            <div className="space-y-1.5">
                <p className="font-medium text-sm">{title}</p>
                {description && (
                    <p className="max-w-lg text-muted-foreground text-sm">{description}</p>
                )}
            </div>
            {action}
        </div>
    );
}
