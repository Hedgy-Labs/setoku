// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../cn";

/** Inline form-error banner (stone — chrome stays neutral). Shared by the
 *  login and change-password forms so their error presentation can't drift. */
export function FormError({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-700", className)}
    >
      {children}
    </div>
  );
}
