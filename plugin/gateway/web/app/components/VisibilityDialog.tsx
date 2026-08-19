// SPDX-License-Identifier: Apache-2.0
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { MIN_PASSWORD_LENGTH } from "../types";

type Vis = "team" | "public";

/**
 * The sharing picker. Two questions, in the order a person thinks about them:
 * WHO can open it (Team or Public, the same two words the app's badge shows),
 * and then, only once it's public, whether a password stands in front of the
 * link. That mirrors the data model
 * (visibility + an optional password) instead of flattening it into three
 * look-alike rows, and it keeps both audience rows the same height so the dialog
 * doesn't lurch when you pick one.
 *
 * Everything is a LOCAL edit until Save (so a mis-click can't expose an app),
 * and Save is focused on open so Enter submits. Exposing an app is admin-only
 * (I9), as is taking a password back OFF a live link; adding or changing one
 * only narrows access, so the app's author can do that themselves.
 */
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
  /** A password is stored: guarding the link while public, dormant while team. */
  hasPassword: boolean;
  /** Admin: may expose an app, and may take a password back off a public one. */
  canMakePublic: boolean;
  /** Called with the chosen visibility and the password change, only when
   *  something actually differs: `undefined` leaves any stored password alone,
   *  a string sets it, null removes it. */
  onSubmit: (next: Vis, password?: string | null) => void;
  onClose: () => void;
}) {
  const [vis, setVis] = useState<Vis>(visibility);
  const [locked, setLocked] = useState(hasPassword);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Reset the pending edit to the live state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setVis(visibility);
      setLocked(hasPassword);
      setPw("");
      setError(null);
    }
  }, [open, visibility, hasPassword]);
  const saveRef = useRef<HTMLButtonElement>(null);

  const isPublic = visibility === "public";
  // A non-admin may not publish an app, and may not unlock one that is already
  // out there. Adding a password to their own live link is theirs to do.
  const mayPublish = canMakePublic || isPublic;
  const mayUnlock = canMakePublic || !hasPassword;

  const submit = (): void => {
    // The password only means anything on a link. A team app keeps any stored
    // one dormant, so a later re-publish can't silently drop the gate.
    const wantsLock = vis === "public" ? locked : hasPassword;
    // Each message says the ONE thing that's wrong; it lands where the helper
    // line was, right under the field, so nothing shifts and nothing repeats.
    if (wantsLock && !pw && !hasPassword) {
      setError("Enter a password.");
      return;
    }
    if (pw && pw.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    const password = wantsLock ? pw || undefined : hasPassword ? null : undefined;
    if (vis === visibility && password === undefined) return onClose(); // nothing changed
    onSubmit(vis, password);
  };

  const Audience = ({ value, label, desc, disabled, note }: { value: Vis; label: string; desc: string; disabled?: boolean; note?: string }) => {
    const checked = vis === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          setVis(value);
          setError(null);
        }}
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
            {visibility === value ? <span className="text-xs font-normal text-stone-400">Current</span> : null}
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">{disabled && note ? note : desc}</span>
        </span>
      </button>
    );
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          // Focus Save on open, and let Enter submit from ANYWHERE in the dialog
          // (radio, field, Save, or dead space). Enter on Cancel still cancels;
          // preventDefault stops Enter from also re-clicking a focused radio.
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
          <div role="radiogroup" aria-label="Who can see this" className="mt-3 space-y-2">
            {/* Labels are the same two words the app's badge shows ("team" /
                "public"); the audience each one means is the description. */}
            <Audience value="team" label="Team" desc="Anyone signed in to this box." />
            <Audience
              value="public"
              label="Public"
              desc="Anyone with the link, no sign-in."
              disabled={!mayPublish}
              note="Anyone with the link. Only an admin can make an app public."
            />
          </div>

          {/* The password rides on the LINK, so it only appears once the link is
              the audience. A hairline rather than another nested card: one box
              inside the dialog is enough. */}
          {vis === "public" ? (
            // pl matches the audience rows' inner offset (1px border + px-3), so
            // the checkbox lands in the same column as the radios above it.
            <div className="mt-4 border-t border-stone-200 pt-4 pl-[13px]">
              <label className={cn("flex items-center gap-2.5 text-sm text-stone-900", !mayUnlock && "opacity-60")}>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-stone-800"
                  checked={locked}
                  disabled={!mayUnlock}
                  onChange={(e) => {
                    setLocked(e.target.checked);
                    setError(null);
                  }}
                />
                Require a password
              </label>
              {locked ? (
                <div className="mt-2.5 pl-[1.625rem]">
                  <input
                    className={cn("input", error && "border-red-400 focus:border-red-500 focus:ring-red-500/20")}
                    type="password"
                    value={pw}
                    autoComplete="new-password"
                    aria-invalid={!!error}
                    aria-describedby="app-password-hint"
                    onChange={(e) => {
                      setPw(e.target.value);
                      setError(null);
                    }}
                    placeholder={hasPassword ? "new password" : `password (${MIN_PASSWORD_LENGTH}+ characters)`}
                  />
                  {/* One slot: the hint becomes the error, so a rejected save
                      corrects the line you were just reading instead of adding a
                      third one further down the dialog. */}
                  <p
                    id="app-password-hint"
                    role={error ? "alert" : undefined}
                    className={cn("mt-1.5 text-xs", error ? "text-red-700" : "text-stone-500")}
                  >
                    {error
                      ? error
                      : hasPassword
                        ? "Leave blank to keep the password that’s set. Changing it re-prompts everyone who already unlocked the link."
                        : "One password for everyone with the link. Share it separately from the link itself."}
                  </p>
                </div>
              ) : !mayUnlock ? (
                <p className="mt-1.5 pl-[1.625rem] text-xs text-stone-500">
                  Only an admin can take the password off a live link.
                </p>
              ) : null}
            </div>
          ) : hasPassword ? (
            // A team app can still hold a password: it stays stored (dormant) so a
            // later re-publish can't silently drop the gate. Say so here, or the
            // one place it matters is the one place it's invisible.
            <p className="mt-3 text-xs text-stone-500">
              A password is saved for this app. It applies again if you share the link.
            </p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
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
