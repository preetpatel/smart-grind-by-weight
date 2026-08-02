'use client';

// Replaces window.prompt() for renaming. A prompt can't be styled, can't be
// cancelled with a stray click, and gives no room to say what the name is for.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function RenameDialog({
    open,
    onOpenChange,
    title,
    description,
    label,
    initialValue,
    onSubmit,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    label: string;
    initialValue: string;
    onSubmit: (value: string) => void;
}) {
    const [value, setValue] = useState(initialValue);

    // Reopening for a different subject must not show the previous one's name.
    useEffect(() => {
        if (open) setValue(initialValue);
    }, [open, initialValue]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-sm">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!value.trim()) return;
                        onSubmit(value.trim());
                        onOpenChange(false);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>
                    <div className="my-5 grid gap-2">
                        <Label htmlFor="rename-value">{label}</Label>
                        <Input
                            id="rename-value"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                        <Button type="submit" disabled={!value.trim()}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
