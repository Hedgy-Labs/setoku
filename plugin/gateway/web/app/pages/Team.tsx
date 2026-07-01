// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from "react";
import { api, type MutationResult } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../auth";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { toast } from "../components/Toast";
import { Status } from "../components/Status";
import { Badge } from "../components/Badge";
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

export function Team() {
  const { me } = useAuth();
  const mayManage = me?.role === "admin";
  const { data, loading, error, reload } = useApi<TeamData>(() => api.team(), []);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [newLogin, setNewLogin] = useState<NewLogin | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");

  const apply = async (p: Promise<MutationResult>) => {
    try {
      const r = await p;
      if (r.flash) toast(r.flash);
      setInvite(r.invite ?? null);
      setNewLogin(r.newLogin ?? null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed.");
    }
  };

  const people = data?.people ?? [];
  const adminCount = data?.adminCount ?? 0;
  const noAgent = people.filter((p) => !p.hasToken).length;

  return (
    <>
      <Heading title="Team">
        Who can sign in here and what their agent may do. Everyone gets an account with a read-only,
        propose-only agent connector; members use the agent and view, admins also approve knowledge.
        The curated context the team builds is shared across everyone. (Curator <i>write</i> connectors
        are a separate, deliberate step — <code className="kbd">admin-cli</code> on the box — never a
        default.)
      </Heading>
      {noAgent > 0 && mayManage ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {noAgent} {noAgent === 1 ? "person has" : "people have"} a login but no agent connector — click{" "}
          <b>Configure agent</b> on their row so they can actually query.
        </div>
      ) : null}

      {invite ? <InviteResult invite={invite} /> : null}
      {newLogin ? <NewLoginResult newLogin={newLogin} /> : null}

      <div className="mt-3">
        {mayManage ? (
          <>
            <form
              className="card flex flex-wrap items-end gap-2 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (inviteEmail.trim()) {
                  void apply(api.invite(inviteEmail.trim()));
                  setInviteEmail("");
                }
              }}
            >
              <label className="min-w-[14rem] flex-1">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-stone-500">
                  Add a teammate (email)
                </span>
                <input
                  className="input"
                  type="email"
                  placeholder="teammate@yourco.com"
                  autoComplete="off"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </label>
              <Button type="submit">Invite</Button>
            </form>
            <p className="mt-2 text-xs text-stone-500">
              Creates their account + a read-only, propose-only agent connector. They join as a{" "}
              <b className="text-stone-700">member</b> (can use the agent + view); promote to{" "}
              <b className="text-stone-700">admin</b> in their row if they should approve knowledge.
            </p>
          </>
        ) : (
          <div className="card px-3 py-2 text-sm text-stone-600">
            You are signed in as a <b className="text-stone-800">member</b> — viewing only. Ask an admin to
            manage the team.
          </div>
        )}
      </div>

      <div className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-stone-500">
        People ({people.length})
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : people.length ? (
        <ul className="card divide-y divide-stone-200">
          {people.map((p) => (
            <PersonRow
              key={p.identity}
              p={p}
              me={me?.identity ?? ""}
              mayManage={!!mayManage}
              adminCount={adminCount}
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

  const agent = !p.hasToken ? (
    <Status color="yellow">no agent</Status>
  ) : p.used ? (
    <Status color="green">connected</Status>
  ) : (
    <Status color="yellow">invited · not connected yet</Status>
  );

  let access: ReactNode;
  if (p.role) {
    access = mayManage ? (
      <select
        className="input w-auto py-1 text-sm"
        aria-label={`role for ${p.identity}`}
        value={p.role}
        disabled={isLastAdmin}
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
    access = <span className="text-xs text-stone-500">no login</span>;
  }

  const items: ReactNode[] = [];
  if (mayManage) {
    if (!p.hasToken)
      items.push(
        <MenuItem key="cfg" onSelect={() => onApply(api.invite(p.identity))}>
          Configure agent
        </MenuItem>,
      );
    else
      items.push(
        <MenuItem
          key="rot"
          onSelect={() =>
            onConfirm({
              title: "Rotate agent connector?",
              body: "Revoke the current connector and issue a new one? The old token stops working immediately.",
              confirmLabel: "Rotate",
              run: () => api.invite(p.identity, true),
            })
          }
        >
          Rotate agent connector
        </MenuItem>,
      );
    if (!p.role)
      items.push(
        <MenuItem key="grant" onSelect={() => onApply(api.users("create", p.identity, "member"))}>
          Grant login
        </MenuItem>,
      );
    if (p.role) {
      items.push(
        <MenuItem
          key="reset"
          onSelect={() =>
            onConfirm({
              title: "Reset password?",
              body: "Reset this password? The current one stops working.",
              confirmLabel: "Reset",
              run: () => api.users("reset", p.identity),
            })
          }
        >
          Reset password
        </MenuItem>,
      );
      if (!isLastAdmin)
        items.push(
          <MenuItem
            key="del"
            danger
            onSelect={() =>
              onConfirm({
                title: "Remove person?",
                body: "Remove this person, deleting their login and revoking their agent connector?",
                confirmLabel: "Remove",
                run: () => api.users("delete", p.identity),
              })
            }
          >
            Remove person
          </MenuItem>,
        );
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
      <span className="min-w-0 truncate font-medium text-stone-900">{p.identity}</span>
      {isSelf ? <span className="text-xs text-stone-500">you</span> : null}
      {agent}
      {access}
      {isLastAdmin ? <span className="text-xs text-stone-500">last admin</span> : null}
      {items.length ? (
        <div className="ml-auto">
          <Menu label={`Actions for ${p.identity}`}>{items}</Menu>
        </div>
      ) : null}
    </li>
  );
}

function InviteResult({ invite }: { invite: Invite }) {
  return (
    <div className="card border-lime-300 bg-lime-50 p-4">
      <div className="mb-2 text-sm font-medium text-lime-700">
        Agent connector for {invite.identity} — send them ONE of these (shown once):
      </div>
      <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">Claude Code (CLI)</div>
      <pre className="mb-3 overflow-x-auto rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-800">
        curl -fsSL {invite.installerUrl} | sh
      </pre>
      <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
        Claude.ai / Desktop app — "Add custom connector" (anyone, incl. non-technical)
      </div>
      <div className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-800">
        <div>
          Paste as <b className="text-stone-900">Remote MCP server URL</b>:
        </div>
        <div className="mt-1 break-all">
          <span className="select-all">
            {invite.mcpUrl}/{invite.token}
          </span>
        </div>
        <div className="mt-1 text-amber-600">
          This URL carries the access token — treat it like a password; rotate it if it leaks.
        </div>
      </div>
      <div className="mt-2 text-xs text-stone-500">
        Once connected (either way), just ask in plain language ("show me signups by week") — Claude charts
        it, using the team's curated context.
      </div>
      {!invite.persisted ? (
        <div className="mt-2 text-xs text-amber-600">
          ⚠ SETOKU_TOKENS_FILE isn't set, so this token is in memory only and is lost on restart. Set it to
          persist invites.
        </div>
      ) : null}
    </div>
  );
}

function NewLoginResult({ newLogin }: { newLogin: NewLogin }) {
  return (
    <div className="card mt-3 border-lime-300 bg-lime-50 p-4">
      <div className="mb-1 text-sm font-medium text-lime-700">
        Web login for {newLogin.username} ({newLogin.role}) — share once:
      </div>
      <div className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-800">
        <div>
          Sign in at <span className="select-all">/admin</span>
        </div>
        <div>
          Username: <span className="select-all">{newLogin.username}</span>
        </div>
        <div>
          Temp password: <span className="select-all">{newLogin.tempPassword}</span>
        </div>
        <div className="mt-1 text-stone-500">They should change it after first sign-in.</div>
      </div>
    </div>
  );
}
