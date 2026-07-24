// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { IS_DEMO, DEMO_MCP } from "../env";

// A slim bar shown only on a demo box (SETOKU_DEMO=1) marking the instance as a
// public demo and linking to the product site. Stone-family chrome, no accent
// (CLAUDE.md): it frames the demo without competing with the apps below. It is
// NOT sticky itself — Layout sticks it together with the header as one unit, so
// it can wrap on narrow screens without clipping or overlapping the nav.
// Self-gating: renders nothing off a demo box, so callers just drop it in.
//
// Composition: the banner sits on the SAME max-w-4xl grid as the header and
// page content (a centered strip over a left-aligned page reads as floating),
// all prose shares one color, and the only white box is the click-to-copy
// control — the call to action. Line one is context, line two is the CTA.
export function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div className="border-b border-stone-200 bg-stone-100 text-xs text-stone-600">
      <div className="mx-auto flex max-w-4xl flex-col gap-y-1 px-5 py-2">
        <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span>
            This is a public demo admin with synthetic data. To try the <em>real</em> demo, connect
            your agent:
          </span>
          <a
            href="https://setoku.com"
            className="font-medium transition hover:text-stone-900"
          >
            setoku.com →
          </a>
        </p>
        <ConnectRow />
      </div>
    </div>
  );
}

type Target = "code" | "claude" | "chatgpt";

const TABS: { id: Target; label: string }[] = [
  { id: "code", label: "Claude Code" },
  { id: "claude", label: "claude.ai" },
  { id: "chatgpt", label: "ChatGPT" },
];

// The connect call-to-action: pill tabs pick the agent (the header nav's pill
// idiom, so the banner speaks the app's language), then one click-to-copy
// control. Claude Code copies the full `claude mcp add` one-liner (the $
// prompt says "run this"); claude.ai and ChatGPT copy the path-authed URL,
// with a muted where-to-paste hint before the chip. Deep vendor menu paths
// churn (I7), so hints stay one step deep.
function ConnectRow() {
  const [target, setTarget] = useState<Target>("code");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (!DEMO_MCP) return null;

  const url = `${window.location.origin}${DEMO_MCP.path}`;
  const command = `claude mcp add --transport http ${DEMO_MCP.connector} ${url}`;

  // The token is the deliberately-public demo credential, so the chip shows the
  // REAL command/URL — what you see is what Copy gives you; CSS ellipsizes only
  // when the row genuinely runs out of room.
  const views: Record<Target, { hint?: string; shown: string; copy: string; prompt?: boolean }> = {
    code: { shown: command, copy: command, prompt: true },
    claude: { shown: url, copy: url, hint: "paste in Settings → Connectors:" },
    chatgpt: { shown: url, copy: url, hint: "add as an app (Developer mode):" },
  };
  const view = views[target];

  const pick = (id: Target) => {
    setTarget(id);
    setCopied(false);
    clearTimeout(timer.current);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.copy);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the title attr still carries the full text */
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span role="group" aria-label="Agent to connect" className="flex shrink-0 select-none items-center gap-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={target === t.id}
            onClick={() => pick(t.id)}
            className={`rounded-md px-2 py-1 font-medium transition ${
              target === t.id
                ? "bg-stone-200 text-stone-900"
                : "text-stone-500 hover:bg-stone-200/60 hover:text-stone-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </span>
      {/* Hint + chip share a NOWRAP group. The chip is the row's flexible
          element: it grows to the grid's right edge (so Copy right-aligns with
          the container in every state) and its code truncates when space runs
          out. The hint precedes the chip, reading as the instruction for the
          URL that follows; on narrow screens the whole group wraps below the
          tabs as a unit (basis-72) instead of the hint orphaning. */}
      <span className="flex min-w-0 flex-1 basis-72 items-center gap-x-2">
        {view.hint ? <span className="shrink-0 whitespace-nowrap text-stone-500">{view.hint}</span> : null}
        <button
          type="button"
          onClick={copy}
          title={view.copy}
          aria-label={`Copy: ${view.copy}`}
          className="group inline-flex min-w-0 flex-1 cursor-pointer items-stretch overflow-hidden rounded-md border border-stone-300/80 bg-white text-left shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition hover:border-stone-400"
        >
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1 font-mono text-[11px] leading-4 text-stone-800">
            {view.prompt ? <span className="select-none text-stone-400">$ </span> : null}
            {view.shown}
          </code>
          <span className="flex shrink-0 select-none items-center gap-1 border-l border-stone-200 bg-stone-50 px-2 font-medium text-stone-600 transition group-hover:bg-stone-100 group-hover:text-stone-900">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
      </span>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="4.2" y="4.2" width="6.6" height="6.6" rx="1.2" />
      <path d="M7.8 4.2V2.6A1.4 1.4 0 0 0 6.4 1.2H2.6A1.4 1.4 0 0 0 1.2 2.6v3.8a1.4 1.4 0 0 0 1.4 1.4h1.6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 6.5 4.8 9.3 10 3.5" />
    </svg>
  );
}
