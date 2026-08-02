// Page title block. Typography carries the hierarchy — no card, no rule, no
// eyebrow label — so pages open the way a document does.
import type { ReactNode } from 'react';

export function PageHeader({
    title,
    description,
    actions,
}: {
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 space-y-1">
                <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
                {description && (
                    <p className="max-w-2xl text-muted-foreground text-sm">{description}</p>
                )}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}
