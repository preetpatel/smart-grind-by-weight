'use client';

// What the grinder can't record. Grind setting is first because it is the one
// field that should visibly explain the trend charts — a step in flow rate
// lines up with the day the burrs moved.
//
// Fields commit on blur rather than behind a Save button: there is nothing to
// validate, the write is local and instant, and a dashboard you have to
// remember to save is a dashboard people stop annotating.
//
// The bean field is a picker over the store's registered bags once any exist
// (the free-text input remains for stores without beans); the shot row is the
// brew the grinder logged after this grind, editable here for corrections or
// for shots logged late.
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type { Annotation, Bean } from '@/lib/analytics/types';

const NO_BEAN = '__none__';

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

function useCommittedNumber(value: number | null, onCommit: (next: number | null) => void) {
    const [draft, setDraft] = useState(value === null ? '' : String(value));
    useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
    return {
        value: draft,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
        onBlur: () => {
            const text = draft.trim();
            const next = text.length ? Number.parseFloat(text) : null;
            const committed = next !== null && Number.isFinite(next) ? next : null;
            if (committed !== value) onCommit(committed);
        },
    };
}

export function AnnotationEditor({
    annotation,
    beans,
    beanSuggestions,
    settingSuggestions,
    onSave,
}: {
    annotation: Annotation | undefined;
    beans: Bean[];
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
    const brewOutput = useCommittedNumber(annotation?.brew_output_g ?? null, (value) =>
        onSave({ brew_output_g: value === null ? null : Math.round(value * 10) / 10 }),
    );
    const brewTime = useCommittedNumber(annotation?.brew_time_s ?? null, (value) =>
        onSave({ brew_time_s: value === null ? null : Math.round(value) }),
    );

    const beanId = annotation?.bean_id ?? null;
    const beanItems: Record<string, string> = { [NO_BEAN]: 'No bean' };
    for (const entry of beans) beanItems[entry.id] = entry.name;

    return (
        <section className="mt-10 border-t pt-6">
            <h2 className="mb-4 font-medium text-base">Notes</h2>

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
                {beans.length > 0 ? (
                    <div className="grid gap-2 sm:col-span-2">
                        <Label htmlFor="ann-bean-picker">Bean</Label>
                        <Select
                            value={beanId ?? NO_BEAN}
                            onValueChange={(value) =>
                                onSave({ bean_id: value === NO_BEAN || !value ? null : value })
                            }
                            items={beanItems}
                        >
                            <SelectTrigger id="ann-bean-picker">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_BEAN}>No bean</SelectItem>
                                {beans.map((entry) => (
                                    <SelectItem key={entry.id} value={entry.id}>
                                        {entry.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {!beanId && annotation?.bean && (
                            <p className="text-muted-foreground text-xs">
                                Noted before beans existed: {annotation.bean}
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="grid gap-2 sm:col-span-2">
                        <Label htmlFor="ann-bean">Bean</Label>
                        {/* Stores without registered beans keep the free-text
                            field — autocompletion still groups the charts. */}
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
                )}
                <div className="grid gap-2">
                    <Label htmlFor="ann-brew-output">Shot yield (g)</Label>
                    <Input
                        id="ann-brew-output"
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="30.1"
                        className="font-mono"
                        {...brewOutput}
                    />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="ann-brew-time">Shot time (s)</Label>
                    <Input
                        id="ann-brew-time"
                        type="number"
                        min="1"
                        placeholder="30"
                        className="font-mono"
                        {...brewTime}
                    />
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
