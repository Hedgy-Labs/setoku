// SPDX-License-Identifier: Apache-2.0
import { cn } from "../cn";

/** The Setoku wordmark in the Bagel Fat One display font. */
export function Brand({ className }: { className?: string }) {
  return <span className={cn("font-brand leading-none text-stone-900", className)}>Setoku</span>;
}
