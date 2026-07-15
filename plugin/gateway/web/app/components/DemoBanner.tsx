// SPDX-License-Identifier: Apache-2.0

// A slim sticky bar shown only on a demo box (SETOKU_DEMO=1) marking the instance
// as a public demo and linking to the product site. Stone-family chrome, no
// accent (CLAUDE.md): it frames the demo without competing with the apps below.
// Sticky at top-0 with z above the sticky header; the header offsets under it.
export function DemoBanner() {
  return (
    <div className="sticky top-0 z-20 flex h-9 items-center justify-center gap-x-2 border-b border-stone-200 bg-stone-100 px-4 text-center text-xs text-stone-600">
      <span>You’re viewing a live demo of Setoku with synthetic data.</span>
      <a
        href="https://setoku.com"
        className="font-medium text-stone-800 underline decoration-stone-300 underline-offset-2 transition hover:text-stone-950 hover:decoration-stone-500"
      >
        Learn more at setoku.com →
      </a>
    </div>
  );
}
