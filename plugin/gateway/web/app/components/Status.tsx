// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../cn";
import type { StatusColor } from "../format";

/** A colored dot + label (flowing / stale / down, connected / no agent, …). */
export function Status({ color, children }: { color: StatusColor; children: ReactNode }) {
  return (
    <span className={cn("status", `status-${color}`)}>
      <span className={cn("dot", `dot-${color}`)} />
      {children}
    </span>
  );
}
