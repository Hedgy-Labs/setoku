// SPDX-License-Identifier: Apache-2.0
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import { cn } from "../cn";

/** A controlled confirm dialog for destructive actions (rotate / reset / remove). */
export function Confirm({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-stone-900">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            {body}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn btn-ghost">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
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
