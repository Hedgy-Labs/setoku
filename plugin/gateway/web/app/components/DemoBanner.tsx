// SPDX-License-Identifier: Apache-2.0

// A slim bar shown only on a demo box (SETOKU_DEMO=1) marking the instance as a
// public demo and linking to the product site. Stone-family chrome, no accent
// (CLAUDE.md): it frames the demo without competing with the apps below. It is
// NOT sticky itself — Layout sticks it together with the header as one unit, so
// it can wrap on narrow screens without clipping or overlapping the nav.
export function DemoBanner() {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-stone-200 bg-stone-100 px-4 py-1.5 text-center text-xs text-stone-600">
      <span>
        This is a public demo with synthetic data.{" "}
        <span className="font-medium text-stone-700">This console is normally private (sign-in required).</span>
      </span>
      <a
        href="https://setoku.com"
        className="font-medium text-stone-800 underline decoration-stone-300 underline-offset-2 transition hover:text-stone-950 hover:decoration-stone-500"
      >
        setoku.com →
      </a>
    </div>
  );
}
