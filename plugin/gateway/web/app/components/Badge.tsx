// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "../cn";

export function Badge({ tone = "idle", children }: { tone?: "ok" | "down" | "idle"; children: ReactNode }) {
  return <span className={cn("badge", `badge-${tone}`)}>{children}</span>;
}
