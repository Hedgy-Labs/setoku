// SPDX-License-Identifier: Apache-2.0
import { Badge } from "./Badge";
import { cn } from "../cn";

/** The team/public visibility pill. For someone who can manage the app (author
 *  or admin) it's a button that opens the visibility picker — same behavior in
 *  either state (open the dialog, choose there), never a state-dependent toggle.
 *  A plain, non-interactive Badge for everyone else. Shared by the app header and
 *  the Apps list so the affordance stays identical. */
export function VisibilityBadge({
  visibility,
  canManage,
  onOpen,
}: {
  visibility: "team" | "public";
  /** Author or admin — may open the picker. */
  canManage: boolean;
  onOpen: () => void;
}) {
  const isPublic = visibility === "public";
  if (!canManage) return <Badge tone={isPublic ? "ok" : "idle"}>{visibility}</Badge>;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Change who can see this"
      className={cn(
        "badge cursor-pointer transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400",
        isPublic
          ? "badge-ok hover:bg-stone-200 hover:text-stone-900"
          : "badge-idle hover:border-stone-400 hover:bg-stone-100 hover:text-stone-700",
      )}
    >
      {visibility}
    </button>
  );
}
