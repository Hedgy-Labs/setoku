// SPDX-License-Identifier: Apache-2.0
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class lists, de-conflicting Tailwind utilities (shadcn's cn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
