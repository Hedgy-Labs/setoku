// SPDX-License-Identifier: Apache-2.0
import { Badge } from "./Badge";
import { cn } from "../cn";

/** A closed padlock — marks a public link that also needs a shared password, so
 *  "public" and "public, but gated" are distinguishable at a glance. */
function Lock() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

/** The team/public visibility pill. For someone who can manage the app (author
 *  or admin) it's a button that opens the visibility picker — same behavior in
 *  either state (open the dialog, choose there), never a state-dependent toggle.
 *  A plain, non-interactive Badge for everyone else. Shared by the app header and
 *  the Apps list so the affordance stays identical. */
export function VisibilityBadge({
  visibility,
  hasPassword,
  canManage,
  onOpen,
}: {
  visibility: "team" | "public";
  /** A shared password guards the public link — shown as a padlock. */
  hasPassword?: boolean;
  /** Author or admin — may open the picker. */
  canManage: boolean;
  onOpen: () => void;
}) {
  const isPublic = visibility === "public";
  const guarded = isPublic && !!hasPassword;
  const label = (
    <span className="inline-flex items-center gap-1">
      {guarded ? <Lock /> : null}
      {visibility}
    </span>
  );
  const title = guarded ? "Public, password-protected. Click to change who can see this." : "Change who can see this";
  if (!canManage) return <Badge tone={isPublic ? "ok" : "idle"}>{label}</Badge>;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={cn(
        "badge cursor-pointer transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400",
        isPublic
          ? "badge-ok hover:bg-stone-200 hover:text-stone-900"
          : "badge-idle hover:border-stone-400 hover:bg-stone-100 hover:text-stone-700",
      )}
    >
      {label}
    </button>
  );
}
