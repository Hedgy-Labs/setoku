// SPDX-License-Identifier: Apache-2.0
import { cn } from "../cn";

/** The Setoku sprout mark + wordmark, set in the neutral chrome (system) font. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-bold tracking-tight leading-none text-stone-900", className)}>
      <svg viewBox="0 0 64 64" className="h-[1.05em] w-[1.05em] shrink-0" fill="currentColor" aria-hidden="true">
        <path d="M32 35 Q24.8 27.88 11.47 25.91 A11 11 0 1 1 26.61 13.21 Q32.37 21.53 32 35 Z" />
        <path d="M32 35 Q32.37 25.88 35.79 19.33 A8 8 0 1 1 46.77 28.54 Q37.86 30.49 32 35 Z" />
        <path d="M29.86 35.18 L29.87 36.49 L29.83 37.72 L29.76 38.89 L29.65 40.02 L29.51 41.12 L29.34 42.17 L29.15 43.2 L28.93 44.2 L28.7 45.17 L28.45 46.13 L28.2 47.08 L27.93 48.02 L27.66 48.96 L27.39 49.9 L27.12 50.84 L26.86 51.8 L26.61 52.77 L26.38 53.76 L26.16 54.78 L25.97 55.82 L25.82 56.9 L25.7 57.92 L34.3 58.08 L34.22 57.2 L34.16 56.4 L34.14 55.58 L34.13 54.74 L34.15 53.88 L34.19 52.99 L34.25 52.08 L34.32 51.14 L34.39 50.18 L34.47 49.19 L34.55 48.17 L34.63 47.12 L34.7 46.04 L34.75 44.93 L34.78 43.79 L34.8 42.61 L34.78 41.4 L34.73 40.15 L34.65 38.87 L34.52 37.55 L34.35 36.19 L34.14 34.82 Z" />
      </svg>
      Setoku
    </span>
  );
}
