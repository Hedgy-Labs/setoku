// SPDX-License-Identifier: Apache-2.0
/**
 * A shared tabular file, viewed in the browser: fetch the file's RAW bytes (the
 * same URL as Download, so it's cached by its content-hash ETag and, on a public
 * link, spends the same per-record budget), parse them here with the server's
 * own parser (lib/table-parse.ts), and hand the rows to the grid. The box never
 * parses or re-serializes a file per view, so there's no view-time size cap
 * beyond the upload cap. Used by the admin app view and the public /p/<id> page.
 */
import { useEffect, useState } from "react";
import { parseTabular } from "../../../lib/table-parse";
import { Grid } from "./Grid";
import { GRID_CSS } from "./styles";

/** A JSON file that isn't rows shows as text; past this it's a prefix. */
const MAX_TEXT_CHARS = 2_000_000;

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "text"; text: string; cut: boolean };

export function FileViewer(props: {
  src: string;
  name: string;
  mime: string;
  /** "omit" on an open public link (credential-free), "same-origin" otherwise. */
  credentials?: RequestCredentials;
  /** The fetch was refused for a lapsed session/unlock (401). */
  onUnauthorized?: () => void;
}): React.ReactElement {
  const { src, name, mime, credentials = "same-origin", onUnauthorized } = props;
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: "loading" });
    (async () => {
      const r = await fetch(src, { credentials, signal: ac.signal });
      if (r.status === 401 && onUnauthorized) return onUnauthorized();
      if (r.status === 429) throw new Error("This file is getting a lot of views right now. Try again in a moment.");
      if (!r.ok) throw new Error(`Couldn’t load the file (${r.status}).`);
      const text = await r.text();
      await new Promise((res) => setTimeout(res, 0)); // let the loading state paint before a long parse
      if (ac.signal.aborted) return;
      const t = parseTabular(text, mime);
      if (t) setState({ kind: "table", columns: t.columns, rows: t.rows });
      else setState({ kind: "text", text: text.slice(0, MAX_TEXT_CHARS), cut: text.length > MAX_TEXT_CHARS });
    })().catch((e: unknown) => {
      if (ac.signal.aborted) return;
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, mime, credentials]);

  if (state.kind === "table") return <Grid columns={state.columns} rows={state.rows} name={name} />;
  return (
    <div className="fg">
      <style>{GRID_CSS}</style>
      {state.kind === "loading" ? (
        <div className="fg-msg">
          <span className="fg-spin" />
          Loading {name}…
        </div>
      ) : state.kind === "error" ? (
        <div className="fg-msg">{state.message}</div>
      ) : (
        <>
          <pre className="fg-pre">{state.text}</pre>
          {state.cut ? <div className="fg-note">Showing the start of this file. Download it for the rest.</div> : null}
        </>
      )}
    </div>
  );
}
