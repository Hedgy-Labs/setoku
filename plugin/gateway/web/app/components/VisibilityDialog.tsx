// SPDX-License-Identifier: Apache-2.0
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useRef, useState } from "react";
import { cn } from "../cn";

type Vis = "team" | "public";

/** A Google-Docs-style visibility picker: one dialog, opened from the badge in
 *  either state, listing Team and Public with the current one marked. The radio
 *  is a LOCAL selection — nothing changes until Save (so a mis-click can't expose
 *  an app), and Save is focused on open so Enter submits. Promoting to Public is
 *  admin-only (I9): the Public row is disabled for non-admins. */
export function VisibilityDialog({
  open,
  visibility,
  canMakePublic,
  onSubmit,
  onClose,
}: {
  open: boolean;
  visibility: Vis;
  /** Admin — may choose Public. */
  canMakePublic: boolean;
  /** Called with the chosen value ONLY when it differs from the current one. */
  onSubmit: (next: Vis) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Vis>(visibility);
  // Reset the pending selection to the live value each time the dialog opens.
  useEffect(() => {
    if (open) setSel(visibility);
  }, [open, visibility]);
  const saveRef = useRef<HTMLButtonElement>(null);
  const submit = (): void => (sel === visibility ? onClose() : onSubmit(sel));

  const Option = ({ value, label, desc, disabled }: { value: Vis; label: string; desc: string; disabled?: boolean }) => {
    const checked = sel === value;
    const current = visibility === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => setSel(value)}
        className={cn(
          "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition",
          checked ? "border-stone-400 bg-stone-50" : "border-stone-200 hover:bg-stone-50",
          disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            checked ? "border-stone-700" : "border-stone-300",
          )}
        >
          {checked ? <span className="h-2 w-2 rounded-full bg-stone-700" /> : null}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium text-stone-900">
            {label}
            {current ? <span className="text-xs font-normal text-stone-400">Current</span> : null}
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">
            {desc}
            {disabled ? " Only an admin can make an app public." : ""}
          </span>
        </span>
      </button>
    );
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          // Focus Save on open, and let Enter submit from ANYWHERE in the dialog
          // (radio, Save, or dead space) — not just when Save has focus. Enter on
          // Cancel still cancels; preventDefault stops Enter from also re-clicking a
          // focused radio.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            saveRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if ((e.target as HTMLElement)?.dataset?.role === "cancel") return;
            e.preventDefault();
            submit();
          }}
        >
          <AlertDialog.Title className="text-base font-semibold text-stone-900">Who can see this?</AlertDialog.Title>
          <AlertDialog.Description className="sr-only">Choose who can open this app, then Save.</AlertDialog.Description>
          <div role="radiogroup" aria-label="Visibility" className="mt-3 space-y-2">
            <Option value="team" label="Team" desc="Anyone signed in to the box can open it." />
            <Option
              value="public"
              label="Public"
              desc="Anyone with the link can open it, no sign-in."
              disabled={!canMakePublic}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel data-role="cancel" className="btn btn-ghost">
              Cancel
            </AlertDialog.Cancel>
            {/* Plain button (not AlertDialog.Action): the parent closes via `open`
                after applying, so nothing changes until this is pressed. */}
            <button ref={saveRef} className="btn btn-primary" onClick={submit}>
              Save
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
