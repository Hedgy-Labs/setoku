// SPDX-License-Identifier: Apache-2.0
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { useRef, type ReactNode } from "react";
import { cn } from "../cn";

/** A controlled confirm dialog for destructive actions (rotate / reset / remove).
 *  Escape cancels (Base UI default). `defaultAction` focuses the confirm button on
 *  open so Enter triggers it — opt-in, and only for REVERSIBLE actions; a
 *  destructive confirm should keep the safer Cancel-focused default (Base UI's
 *  default initialFocus lands on the first tabbable element, which is Cancel). */
export function Confirm({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  defaultAction,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  defaultAction?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          // Move initial focus to the confirm button so Enter activates it; the
          // default (undefined → Base UI's first tabbable) focuses Cancel, the safe
          // default we keep for destructive ones.
          initialFocus={defaultAction ? actionRef : undefined}
        >
          <AlertDialog.Title className="text-base font-semibold text-stone-900">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            {body}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className="btn btn-ghost">Cancel</AlertDialog.Close>
            {/* Plain button (not AlertDialog.Close): the parent closes via the `open`
                prop from onConfirm, so this only needs to fire the action. */}
            <button
              ref={actionRef}
              className={cn("btn", danger ? "bg-red-600 text-white hover:bg-red-700" : "btn-primary")}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
