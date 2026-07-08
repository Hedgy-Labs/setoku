// SPDX-License-Identifier: Apache-2.0
import { Badge } from "./Badge";
import { cn } from "../cn";

/** The team/public visibility pill, which doubles as a control when the viewer
 *  can change it: an admin may promote team→public (a deliberate exposure, so the
 *  parent routes that through a confirm); the author or an admin may take a public
 *  app back to team-only. Renders a plain, non-interactive Badge otherwise. Shared
 *  by the app header and the Apps list so the affordance + rules stay identical. */
export function VisibilityBadge({
  visibility,
  canManage,
  isAdmin,
  onMakePublic,
  onMakeTeam,
}: {
  visibility: "team" | "public";
  /** Author or admin — may demote public→team. */
  canManage: boolean;
  /** Admin — may promote team→public. */
  isAdmin: boolean;
  onMakePublic: () => void;
  onMakeTeam: () => void;
}) {
  const isPublic = visibility === "public";
  const clickable = isPublic ? canManage : isAdmin;
  if (!clickable) return <Badge tone={isPublic ? "ok" : "idle"}>{visibility}</Badge>;
  return (
    <button
      type="button"
      onClick={isPublic ? onMakeTeam : onMakePublic}
      title={isPublic ? "Make team-only" : "Make public"}
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
