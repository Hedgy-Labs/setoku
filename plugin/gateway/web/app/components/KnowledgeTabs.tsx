// SPDX-License-Identifier: Apache-2.0
import { NavLink } from "react-router-dom";
import { cn } from "../cn";

/** Page-level sub-nav for the Knowledge tab: the curated store vs. the review
 *  queue. Underline style so it reads as navigation, distinct from the pill
 *  view-mode toggles inside the content. The pending count (when known) rides
 *  on Review in both views. */
export function KnowledgeTabs({ pending }: { pending?: number }) {
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm font-medium transition",
      isActive
        ? "border-stone-800 text-stone-900"
        : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800",
    );
  return (
    <div className="mb-5 flex gap-5 border-b border-stone-200">
      <NavLink to="/knowledge" end className={link}>
        Curated
      </NavLink>
      <NavLink to="/knowledge/review" className={link}>
        Review
        {typeof pending === "number" && pending > 0 ? (
          <span className="rounded-full bg-stone-200 px-1.5 py-px text-[10px] font-semibold tabular-nums text-stone-700">
            {pending}
          </span>
        ) : null}
      </NavLink>
    </div>
  );
}
