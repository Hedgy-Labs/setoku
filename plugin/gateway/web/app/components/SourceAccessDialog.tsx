// SPDX-License-Identifier: Apache-2.0
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { beatIsLive } from "../format";
import { cn } from "../cn";
import { lakeFamilies, familyOf, BUSINESS_FAMILY } from "../../../lib/sources";
import type { SourcesData } from "../types";

/** The Team page "Data access…" dialog (I9 — a human act, no MCP tool can do
 *  this): one checkbox per lake source family; checked = this person's agent
 *  may query it. Modeled on VisibilityDialog — the selection is LOCAL and
 *  commits only on Save, which is focused on open so Enter submits. Unchecking
 *  stores a DENY; anything unlisted (including sources connected later) stays
 *  allowed, so new connectors are opted in by default. Enforcement is the
 *  ClickHouse role subset — the engine refuses denied queries and hides the
 *  tables from discovery; this dialog only edits the deny set. */
export function SourceAccessDialog({
  open,
  identity,
  denies,
  onSubmit,
  onClose,
}: {
  open: boolean;
  identity: string;
  /** The live denied-family slugs for this person. */
  denies: string[];
  /** Called with the full replacement deny set ONLY when it changed. */
  onSubmit: (denies: string[]) => void;
  onClose: () => void;
}) {
  const [denied, setDenied] = useState<Set<string>>(new Set(denies));
  // Reset the pending selection to the live value each time the dialog opens.
  useEffect(() => {
    if (open) setDenied(new Set(denies));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- denies is fresh per open
  }, [open]);
  const saveRef = useRef<HTMLButtonElement>(null);

  // Which families are actually flowing — fetched lazily so the Team page
  // doesn't probe the lake until someone opens this. The list shows CONNECTED
  // families only (a box never hooks up Monarch etc., so offering it is noise),
  // plus any family this person is already denied so a lingering restriction
  // stays visible and removable.
  const { data: sources, loading } = useApi<SourcesData | null>(
    () => (open ? api.sources() : Promise.resolve(null)),
    [open],
  );
  const connected = new Set<string>();
  for (const t of sources?.lake.tables ?? []) {
    if ((t.rows ?? 0) > 0 || beatIsLive(t.beat)) connected.add(familyOf(t.source));
  }
  // The business-DB mirror (Postgres) is "connected" when it carries any table.
  if ((sources?.mirror.tables.length ?? 0) > 0) connected.add(BUSINESS_FAMILY.family);

  // Connected first, then a denied-but-quiet family; catalog order within each
  // partition (sort() is stable).
  const families = lakeFamilies()
    .filter((f) => connected.has(f.family) || denies.includes(f.slug))
    .sort((a, b) => Number(connected.has(b.family)) - Number(connected.has(a.family)));
  // A deny can outlive its connector entirely (family dropped from the catalog)
  // — surface those unknown slugs too so they can still be un-checked.
  const stale = [...denied].filter((d) => !lakeFamilies().some((f) => f.slug === d));

  const same = (): boolean => {
    const live = new Set(denies);
    return denied.size === live.size && [...denied].every((d) => live.has(d));
  };
  const submit = (): void => (same() ? onClose() : onSubmit([...denied].sort()));
  const toggle = (slug: string): void => {
    setDenied((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const RowBox = ({ slug, label, hint }: { slug: string; label: string; hint?: string }) => {
    const allowed = !denied.has(slug);
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={allowed}
        onClick={() => toggle(slug)}
        className={cn(
          "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition",
          allowed ? "border-stone-200 hover:bg-stone-50" : "border-stone-300 bg-stone-50",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
            allowed ? "border-stone-700 bg-stone-700" : "border-stone-300 bg-white",
          )}
        >
          {allowed ? (
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-none stroke-white" strokeWidth="2">
              <path d="M1.5 5.5l2.5 2.5 4.5-5" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0">
          <span className={cn("block text-sm font-medium", allowed ? "text-stone-900" : "text-stone-500")}>
            {label}
          </span>
          {hint ? <span className="mt-0.5 block text-xs text-stone-400">{hint}</span> : null}
        </span>
      </button>
    );
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          initialFocus={saveRef}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if ((e.target as HTMLElement)?.dataset?.role === "cancel") return;
            e.preventDefault();
            submit();
          }}
        >
          <AlertDialog.Title className="text-base font-semibold text-stone-900">Data access</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs leading-relaxed text-stone-500">
            Checked sources are queryable by {identity}’s agent; new sources are on by default.
          </AlertDialog.Description>
          <div
            role="group"
            aria-label={`Sources ${identity} can query`}
            className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1"
          >
            {loading && !sources ? (
              <p className="py-2 text-xs text-stone-400">Loading connected sources…</p>
            ) : !families.length && !stale.length ? (
              <p className="py-2 text-xs text-stone-400">
                No data sources are connected yet — nothing to restrict.
              </p>
            ) : (
              <>
                {families.map((f) => (
                  <RowBox
                    key={f.slug}
                    slug={f.slug}
                    label={f.family}
                    hint={connected.has(f.family) ? undefined : "not connected"}
                  />
                ))}
                {stale.map((slug) => (
                  <RowBox key={slug} slug={slug} label={slug} hint="source no longer in the catalog" />
                ))}
              </>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close data-role="cancel" className="btn btn-ghost">
              Cancel
            </AlertDialog.Close>
            {/* Plain button (not AlertDialog.Close): the parent closes via `open`
                after applying, so nothing changes until this is pressed. */}
            <button ref={saveRef} className="btn btn-primary" onClick={submit}>
              Save
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
