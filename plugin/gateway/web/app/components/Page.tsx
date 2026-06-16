// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

/** Page heading with an optional sub line. */
export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="mt-1 text-sm leading-relaxed text-stone-600">{children}</p> : null}
    </div>
  );
}

/** A neutral flash banner for action results. */
export function Flash({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-stone-300 bg-stone-100 px-3 py-2 text-sm text-stone-700">
      {children}
    </div>
  );
}

export function Loading() {
  return <div className="card p-8 text-center text-stone-500">Loading…</div>;
}

export function ErrorMsg({ children }: { children: ReactNode }) {
  return <div className="card p-8 text-center text-red-600">{children}</div>;
}
