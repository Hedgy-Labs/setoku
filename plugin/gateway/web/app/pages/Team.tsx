// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { api, type MutationResult } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Badge } from "../components/Badge";
import { cn } from "../cn";
import { Button } from "../components/Button";
import { Menu, MenuItem } from "../components/Menu";
import { Confirm } from "../components/Confirm";
import type { Invite, NewLogin, Person, TeamData } from "../types";

const ROLES = ["admin", "member"];

interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<MutationResult>;
}

/** The shown-once credentials a mutation just minted — drives the dialog.
 *  Any combination: both (fresh invite), invite-only (reset connector /
 *  configure agent), login-only (reset password / grant login). */
interface Creds {
  identity: string;
  invite: Invite | null;
  newLogin: NewLogin | null;
}

export function Team() {
  const { me } = useAuth();
  const mayManage = me?.role === "admin";
  const { data, loading, error, reload } = useApi<TeamData>(() => api.team(), []);
  const [creds, setCreds] = useState<Creds | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");

  const apply = async (p: Promise<MutationResult>) => {
    try {
      const r = await p;
      if (r.flash) toast(r.flash);
      if (r.invite || r.newLogin)
        setCreds({
          identity: r.invite?.identity ?? r.newLogin!.username,
          invite: r.invite ?? null,
          newLogin: r.newLogin ?? null,
        });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  const people = data?.people ?? [];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-[16rem] max-w-xl flex-1">
          <Heading title="Team">
            Everyone you invite gets a web login and a read-only agent connector; admins also approve
            knowledge.
          </Heading>
        </div>
        {mayManage ? (
          <form
            className="flex shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              if (inviteEmail.trim()) {
                void apply(api.invite(inviteEmail.trim()));
                setInviteEmail("");
              }
            }}
          >
            <input
              className="input w-60 rounded-r-none"
              type="email"
              placeholder="teammate@yourco.com"
              aria-label="Teammate email"
              autoComplete="off"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <Button type="submit" className="-ml-px rounded-l-none">
              Invite
            </Button>
          </form>
        ) : (
          <p className="mt-1 text-xs text-stone-500">Viewing only — ask an admin to manage the team.</p>
        )}
      </div>

      <div className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-stone-500">
        People ({people.length})
        {(() => {
          const n = people.filter((p) => !(p.hasToken && p.role)).length;
          return n > 0 ? <span className="ml-2 text-stone-400">· {n} need setup</span> : null;
        })()}
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : people.length ? (
        <ul className="card divide-y divide-stone-100 overflow-hidden">
          {people.map((p) => (
            <PersonRow
              key={p.identity}
              p={p}
              me={me?.identity ?? ""}
              mayManage={!!mayManage}
              adminCount={data?.adminCount ?? 0}
              onApply={apply}
              onConfirm={setConfirm}
            />
          ))}
        </ul>
      ) : (
        <div className="card p-8 text-center text-stone-500">No one yet. Invite a teammate above.</div>
      )}

      <Confirm
        open={!!confirm}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.confirmLabel}
        danger
        onConfirm={() => {
          if (confirm) void apply(confirm.run());
          setConfirm(null);
        }}
        onClose={() => setConfirm(null)}
      />
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} />
    </>
  );
}

function PersonRow({
  p,
  me,
  mayManage,
  adminCount,
  onApply,
  onConfirm,
}: {
  p: Person;
  me: string;
  mayManage: boolean;
  adminCount: number;
  onApply: (pr: Promise<MutationResult>) => void;
  onConfirm: (c: ConfirmSpec) => void;
}) {
  const isSelf = p.identity === me;
  const isLastAdmin = p.role === "admin" && adminCount <= 1;

  // One quiet sub-line says the state in words; the monogram's dot says it at
  // a glance (green only when the person is fully set up AND has connected).
  const complete = p.hasToken && !!p.role;
  let subline: string;
  if (complete && p.used) subline = "agent connected";
  else if (complete) subline = "invited · agent not connected yet";
  else if (!p.hasToken) subline = "no agent connector";
  else subline = p.used ? "agent connected · no web login" : "no web login";
  if (p.envBacked) subline += " · pinned in .env";

  let access: ReactNode;
  if (p.role) {
    access = mayManage ? (
      <select
        className="input w-auto border-transparent bg-transparent py-1 text-sm text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
        aria-label={`role for ${p.identity}`}
        title={isLastAdmin ? "Last admin — the server refuses demotion or removal" : undefined}
        value={p.role}
        onChange={(e) => onApply(api.users("role", p.identity, e.target.value))}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    ) : (
      <Badge tone={p.role === "admin" ? "ok" : "idle"}>{p.role}</Badge>
    );
  } else {
    access = null;
  }

  const items: ReactNode[] = [];
  if (mayManage) {
    if (p.hasToken)
      items.push(
        <MenuItem
          key="reset-connector"
          onSelect={() =>
            onConfirm({
              title: "Reset agent connector?",
              body: "A new connector is issued and the old token stops working immediately.",
              confirmLabel: "Reset",
              run: () => api.invite(p.identity, true),
            })
          }
        >
          Reset agent connector
        </MenuItem>,
      );
    else
      items.push(
        <MenuItem key="cfg" onSelect={() => onApply(api.invite(p.identity))}>
          Configure agent
        </MenuItem>,
      );
    if (p.role)
      items.push(
        <MenuItem
          key="reset-password"
          onSelect={() =>
            onConfirm({
              title: "Reset password?",
              body: "A new password is issued and the current one stops working.",
              confirmLabel: "Reset",
              run: () => api.users("reset", p.identity),
            })
          }
        >
          Reset password
        </MenuItem>,
      );
    else
      items.push(
        <MenuItem key="grant" onSelect={() => onApply(api.users("create", p.identity, "member"))}>
          Grant login
        </MenuItem>,
      );
    items.push(
      <MenuItem
        key="remove"
        danger
        onSelect={() =>
          onConfirm({
            title: "Remove person?",
            body:
              `Remove ${p.identity}? Their login is deleted and their agent connector stops working immediately.` +
              (p.envBacked
                ? " Their connector token is pinned in the box's .env, so it returns on restart — the server explains how to remove it for good."
                : ""),
            confirmLabel: "Remove",
            run: () => api.users("delete", p.identity),
          })
        }
      >
        Remove
      </MenuItem>,
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-stone-50">
      <Monogram p={p} complete={complete} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-stone-900">{p.identity}</span>
          {isSelf ? (
            <span className="rounded bg-stone-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              you
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-stone-500">{subline}</span>
      </span>
      {access}
      {items.length ? <Menu label={`Actions for ${p.identity}`}>{items}</Menu> : null}
    </li>
  );
}

/** Monochrome monogram disc with a presence dot: green = set up and connected,
 *  amber = anything still pending (invited, or a legacy half-person). */
function Monogram({ p, complete }: { p: Person; complete: boolean }) {
  return (
    <span
      className="relative flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-stone-200 text-sm font-semibold uppercase text-stone-600"
      title={p.envBacked ? "Connector pinned in the box's .env (legacy)" : undefined}
    >
      {p.identity.slice(0, 1)}
      <span
        className={cn(
          "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-white",
          complete && p.used ? "bg-lime-500" : "bg-amber-500",
        )}
      />
    </span>
  );
}

/** The one thing to send: a ready-to-paste message with whatever this mutation
 *  minted (connector, login, or both). The recipient picks their own path. */
function handoffMessage(creds: Creds): string {
  const origin = creds.invite?.mcpUrl.replace(/\/mcp$/, "");
  const parts: string[] = [];
  if (creds.invite)
    parts.push(
      "Connect your agent — pick ONE:\n" +
        "• Claude.ai / Claude Desktop: add a custom connector (Settings → Connectors) with this URL:\n" +
        `  ${creds.invite.mcpUrl}/${creds.invite.token}\n` +
        `• Claude Code (terminal): curl -fsSL ${creds.invite.installerUrl} | sh`,
    );
  if (creds.newLogin)
    parts.push(
      `Web login${origin ? ` (${origin}/admin)` : " (/admin)"}:\n` +
        `  Username: ${creds.newLogin.username}\n` +
        `  Password: ${creds.newLogin.tempPassword}`,
    );
  if (creds.invite)
    parts.push('Once connected, just ask in plain language ("show me signups by week").');
  parts.push("This message carries your access — don't forward it.");
  return parts.join("\n\n");
}

/** The shown-once hand-off: ONE ready-to-send message, one copy button.
 *  Closing discards it (reset the connector/password to issue new ones). */
function CredentialsDialog({ creds, onClose }: { creds: Creds | null; onClose: () => void }) {
  const message = creds ? handoffMessage(creds) : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast("Message copied — send it over a private channel.");
    } catch {
      toast("Couldn't reach the clipboard — select the message text and copy it.");
    }
  };
  return (
    <AlertDialog.Root open={!!creds} onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          {creds ? (
            <>
              <AlertDialog.Title className="text-base font-semibold text-stone-900">
                {creds.identity} — send them this
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
                One message with everything they need. Shown once — it can’t be retrieved after you
                close this; reset the agent connector or the password to issue new ones.
              </AlertDialog.Description>
              <pre className="mt-3 max-h-72 select-text overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-mono text-xs leading-relaxed text-stone-700">
                {message}
              </pre>
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialog.Close className="btn btn-ghost">Done</AlertDialog.Close>
                <Button onClick={() => void copy()}>Copy message</Button>
              </div>
            </>
          ) : null}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
