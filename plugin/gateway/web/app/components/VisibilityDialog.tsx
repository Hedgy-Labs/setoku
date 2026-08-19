// SPDX-License-Identifier: Apache-2.0
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { MIN_PASSWORD_LENGTH } from "../types";

type Vis = "team" | "public";
/** The three states a person actually chooses between. "protected" is still
 *  visibility=public on the wire — plus a shared password on the link. */
type Choice = "team" | "public" | "protected";

/** A Google-Docs-style sharing picker: one dialog, opened from the badge in any
 *  state, listing Team / Anyone with the link / Anyone with the link and password,
 *  with the current one marked. The radio is a LOCAL selection — nothing changes
 *  until Save (so a mis-click can't expose an app), and Save is focused on open so
 *  Enter submits. Exposing an app publicly is admin-only (I9), as is taking a
 *  password back off a public link — a non-admin author sees those rows locked,
 *  each saying which rule locked it. */
export function VisibilityDialog({
  open,
  visibility,
  hasPassword,
  canMakePublic,
  onSubmit,
  onClose,
}: {
  open: boolean;
  visibility: Vis;
  /** A shared password is stored — guarding the link while the app is public,
   *  dormant while it's team-only. */
  hasPassword: boolean;
  /** Admin — may expose an app, and may take a password back off a public one. */
  canMakePublic: boolean;
  /** Called with the chosen visibility and the password change ONLY when
   *  something actually differs: `undefined` leaves any stored password alone,
   *  a string sets it, null removes it. */
  onSubmit: (next: Vis, password?: string | null) => void;
  onClose: () => void;
}) {
  const current: Choice = visibility === "public" ? (hasPassword ? "protected" : "public") : "team";
  const [sel, setSel] = useState<Choice>(current);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Reset the pending selection to the live value each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSel(current);
      setPw("");
      setError(null);
    }
  }, [open, current]);
  const saveRef = useRef<HTMLButtonElement>(null);

  const submit = (): void => {
    if (sel === "protected") {
      // A typed password replaces whatever is there; an empty field keeps the
      // existing one (so "still protected, don't change it" is one click) — but
      // there has to BE one to keep.
      if (!pw && !hasPassword) {
        setError(`Enter a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (pw && pw.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (sel === current && !pw) return onClose(); // nothing to change
      return onSubmit("public", pw || undefined);
    }
    if (sel === current) return onClose();
    // Leaving "protected" for the open link drops the password; going team-only
    // leaves it stored, so re-publishing later can't silently unlock the link.
    return onSubmit(sel === "public" ? "public" : "team", sel === "public" && hasPassword ? null : undefined);
  };

  // Who may pick what. EXPOSING an app is admin-only (I9), and so is taking a
  // password back OFF a public link — both widen who can read it. TIGHTENING an
  // app you already published (adding or changing its password) is yours to do,
  // which is what the server allows; the dialog has to offer it or that path is
  // unreachable. Each locked row says which rule locked it.
  const isPublic = visibility === "public";
  const openDenied = !canMakePublic && (!isPublic || current === "protected");
  const protectDenied = !canMakePublic && !isPublic;
  const Option = ({ value, label, desc, disabled, deniedNote, children }: { value: Choice; label: string; desc: string; disabled?: boolean; deniedNote?: string; children?: React.ReactNode }) => {
    const checked = sel === value;
    return (
      <div
        className={cn(
          "rounded-lg border transition",
          checked ? "border-stone-400 bg-stone-50" : "border-stone-200",
          disabled && "opacity-50",
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => {
            setSel(value);
            setError(null);
          }}
          className={cn(
            "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left",
            !checked && !disabled && "hover:bg-stone-50",
            disabled && "cursor-not-allowed",
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
              {current === value ? <span className="text-xs font-normal text-stone-400">Current</span> : null}
            </span>
            <span className="mt-0.5 block text-xs text-stone-500">
              {desc}
              {disabled && deniedNote ? ` ${deniedNote}` : ""}
            </span>
          </span>
        </button>
        {checked ? children : null}
      </div>
    );
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          // Focus Save on open, and let Enter submit from ANYWHERE in the dialog
          // (radio, Save, or dead space) — not just when Save has focus. Enter on
          // Cancel still cancels; preventDefault stops Enter from also re-clicking a
          // focused radio.
          initialFocus={saveRef}
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
              label="Anyone with the link"
              desc="No sign-in — the link is the only thing needed."
              disabled={openDenied}
              deniedNote={
                current === "protected"
                  ? "Only an admin can take the password off a public link."
                  : "Only an admin can share an app publicly."
              }
            />
            <Option
              value="protected"
              label="Anyone with the link and password"
              desc="No sign-in, but they have to type a shared password first."
              disabled={protectDenied}
              deniedNote="Only an admin can share an app publicly."
            >
              <div className="px-3 pb-3">
                <input
                  className="input"
                  type="password"
                  value={pw}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setPw(e.target.value);
                    setError(null);
                  }}
                  placeholder={
                    hasPassword ? "leave blank to keep the current password" : `password (${MIN_PASSWORD_LENGTH}+ characters)`
                  }
                />
                <p className="mt-1.5 text-xs text-stone-500">
                  One password for everyone with the link — share it separately from the link itself. Changing it signs
                  out everyone who already unlocked the app.
                </p>
              </div>
            </Option>
          </div>
          {error ? <p className="mt-3 text-xs text-red-700">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close data-role="cancel" className="btn btn-ghost">
              Cancel
            </AlertDialog.Close>
            {/* Plain button (not AlertDialog.Close): the parent closes via `open`
                after applying, so nothing changes until this is pressed. */}
            <button ref={saveRef} className="btn btn-primary" onClick={submit}>
              Save
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
