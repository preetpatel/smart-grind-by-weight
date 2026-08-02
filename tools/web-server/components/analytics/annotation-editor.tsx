'use client';

// What the grinder can't record. Grind setting is first because it is the one
// field that should visibly explain the trend charts — a step in flow rate
// lines up with the day the burrs moved.
//
// Fields commit on blur rather than behind a Save button: there is nothing to
// validate, the write is local and instant, and a dashboard you have to
// remember to save is a dashboard people stop annotating.
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Annotation } from '@/lib/analytics/types';

function useCommittedField(value: string | null, onCommit: (next: string | null) => void) {
    const [draft, setDraft] = useState(value ?? '');
    // Adopt external changes (a cloud sync landing) unless mid-edit.
    useEffect(() => setDraft(value ?? ''), [value]);
    return {
        value: draft,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
        onBlur: () => {
            const next = draft.trim();
            if (next !== (value ?? '')) onCommit(next.length ? next : null);
        },
    };
}

export function AnnotationEditor({
    annotation,
    beanSuggestions,
    settingSuggestions,
    onSave,
}: {
    annotation: Annotation | undefined;
    beanSuggestions: string[];
    settingSuggestions: string[];
    onSave: (patch: Partial<Omit<Annotation, 'sha256'>>) => void;
}) {
    const bean = useCommittedField(annotation?.bean ?? null, (value) => onSave({ bean: value }));
    const roast = useCommittedField(annotation?.roast_date ?? null, (value) =>
        onSave({ roast_date: value }),
    );
    const setting = useCommittedField(annotation?.grind_setting ?? null, (value) =>
        onSave({ grind_setting: value }),
    );
    const note = useCommittedField(annotation?.note ?? null, (value) => onSave({ note: value }));
    const tags = useCommittedField(annotation?.tags.join(', ') ?? null, (value) =>
        onSave({
            tags: (value ?? '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
        }),
    );

    return (
        <section className="mt-10 border-t pt-6">
            <h2 className="font-medium text-base">Notes</h2>
            <p className="mt-1 mb-4 text-muted-foreground text-sm">
                Kept in this browser, and in your cloud store when you have one. The grind setting
                shows up as a marker on the trend charts.
            </p>

            <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                    <Label htmlFor="ann-setting">Grind setting</Label>
                    <Input
                        id="ann-setting"
                        list="ann-setting-options"
                        placeholder="2.4"
                        className="font-mono"
                        {...setting}
                    />
                    <datalist id="ann-setting-options">
                        {settingSuggestions.map((option) => (
                            <option key={option} value={option} />
                        ))}
                    </datalist>
                </div>
                <div className="grid gap-2 sm:col-span-2">
                    <Label htmlFor="ann-bean">Bean</Label>
                    {/* Autocompleting from what you have typed before gives most
                        of the grouping benefit of a real Bean entity without the
                        relational machinery. */}
                    <Input
                        id="ann-bean"
                        list="ann-bean-options"
                        placeholder="Kenya Nyeri, washed"
                        {...bean}
                    />
                    <datalist id="ann-bean-options">
                        {beanSuggestions.map((option) => (
                            <option key={option} value={option} />
                        ))}
                    </datalist>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="ann-roast">Roast date</Label>
                    <Input id="ann-roast" type="date" className="font-mono" {...roast} />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                    <Label htmlFor="ann-tags">Tags</Label>
                    <Input id="ann-tags" placeholder="espresso, dialling in" {...tags} />
                </div>
                <div className="grid gap-2 sm:col-span-3">
                    <Label htmlFor="ann-note">Note</Label>
                    <Input id="ann-note" placeholder="Choked the basket — go coarser" {...note} />
                </div>
            </div>
        </section>
    );
}
