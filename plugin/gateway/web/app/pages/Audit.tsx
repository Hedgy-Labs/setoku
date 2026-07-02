// SPDX-License-Identifier: Apache-2.0
import { api } from "../api";
import { useApi } from "../hooks";
import { Heading, Loading, ErrorMsg } from "../components/Page";
import { auditSummary } from "../format";
import type { AuditRow } from "../types";

export function Audit() {
  const { data, loading, error } = useApi<AuditRow[]>(() => api.audit(), []);
  return (
    <>
      <Heading title="Audit log">
        Who did what on this box — sign-ins, agent tool calls, approvals, team and app changes.
        Append-only; newest first.
      </Heading>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorMsg>{error}</ErrorMsg>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
                <th className="px-4 py-2.5 font-medium">when (UTC)</th>
                <th className="px-4 py-2.5 font-medium">who</th>
                <th className="px-4 py-2.5 font-medium">action</th>
                <th className="px-4 py-2.5 font-medium">detail</th>
              </tr>
            </thead>
            <tbody>
              {data && data.length ? (
                data.map((r, i) => (
                  <tr key={i} className="border-b border-stone-200/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-stone-500">
                      {String(r.ts).slice(0, 19)}
                    </td>
                    <td className="px-4 py-2.5 text-stone-700">{r.user}</td>
                    <td className="px-4 py-2.5">
                      <code className="kbd">{r.tool}</code>
                    </td>
                    <td className="px-4 py-2.5 text-stone-600">{auditSummary(r.payload)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-stone-500">
                    No activity yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
