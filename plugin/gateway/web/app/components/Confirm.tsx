// SPDX-License-Identifier: Apache-2.0
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactNode } from "react";
import { cn } from "../cn";

/** A controlled confirm dialog for destructive actions (rotate / reset / remove).
 *  Escape cancels (Radix default). `defaultAction` focuses the confirm button on
 *  open so Enter triggers it — opt-in, and only for REVERSIBLE actions; a
 *  destructive confirm should keep the safer Cancel-focused default. */
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
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          // Move initial focus to the confirm button so Enter activates it; Radix
          // otherwise focuses Cancel (the safe default we keep for destructive ones).
          onOpenAutoFocus={
            defaultAction
              ? (e) => {
                  e.preventDefault();
                  actionRef.current?.focus();
                }
              : undefined
          }
        >
          <AlertDialog.Title className="text-base font-semibold text-stone-900">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            {body}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn btn-ghost">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              ref={actionRef}
              className={cn("btn", danger ? "bg-red-600 text-white hover:bg-red-700" : "btn-primary")}
              onClick={onConfirm}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
