// SPDX-License-Identifier: Apache-2.0
/**
 * Integration coverage for shared files (lib/files.ts): the publish_file tool
 * (inline + upload-URL paths, attach gates), the one-time PUT /u/<nonce> upload,
 * the public and team download routes with their headers and gates, and the
 * file viewer served through the app frame. Boots the real http.ts against a
 * fake lake + throwaway SQLite stores, like apps-integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { KnowledgeStore } from "../plugin/gateway/lib/store";
import { hashPassword } from "../plugin/gateway/lib/accounts";
import { spawnGateway, waitHealthy, connect as gwConnect, call, ROOT } from "./lib/gateway";
import { startFakeLake } from "./lib/fakelake";

const PORT = 38741;
const BASE = `http://127.0.0.1:${PORT}`;
/** The spawned gateway's per-upload cap (env override) — small, so the
 *  over-cap paths are testable without a 50 MB body. */
const UPLOAD_CAP = 4_000;

const lake = startFakeLake(() => ({ rows: [{ n: "1" }] }));
process.env.SETOKU_LAKE_URL = lake.url;

let proc: Subprocess;
let tmp = "";
let ana: McpClient; // analyst "ana"
let bob: McpClient; // analyst "bob"

/** The share id out of a publish_file / publish_app reply (`get_app("<id>")`). */
const idOf = (text: string): string => text.match(/get_app\("([^"]+)"\)/)?.[1] ?? "";
/** The upload URL out of a content-less publish_file reply. */
const uploadUrlOf = (text: string): string => text.match(/"(http[^"]+\/u\/[^"]+)"/)?.[1] ?? "";

function setokuOf(html: string): { panels: Record<string, { columns: string[]; rows: Record<string, unknown>[]; truncated?: boolean }> } {
  const json = html.split("window.__SETOKU__=")[1]?.split("</script>")[0]?.replace(/;\s*$/, "") ?? "{}";
  return JSON.parse(json);
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`${BASE}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "boss", password: "s3cret-pass" }),
  });
  return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], csrf: (await r.json()).csrf };
}

async function adminPost(api: string, body: unknown): Promise<Response> {
  const s = await login();
  return fetch(`${BASE}/admin/api/${api}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": s.csrf },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-files-int-"));
  fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(tmp, ".setoku"), { recursive: true });
  const dbPath = path.join(tmp, "knowledge.db");
  const store = new KnowledgeStore(dbPath);
  store.createAccount({ username: "boss", pwhash: await hashPassword("s3cret-pass"), role: "admin" });
  store.db.close();
  proc = spawnGateway({
    SETOKU_PROJECT_DIR: tmp,
    SETOKU_DB_PATH: dbPath,
    SETOKU_LAKE_URL: lake.url,
    SETOKU_TOKENS: "tok_ana=ana,tok_bob=bob",
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_PUBLIC_URL: BASE,
    SETOKU_COOKIE_INSECURE: "1",
    SETOKU_FILES_MAX_UPLOAD_BYTES: String(UPLOAD_CAP),
  });
  await waitHealthy(BASE);
  ana = await gwConnect(BASE, "tok_ana", "ana");
  bob = await gwConnect(BASE, "tok_bob", "bob");
}, 30_000);

afterAll(async () => {
  await ana?.close();
  await bob?.close();
  proc?.kill();
  lake.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("publish_file — inline", () => {
  it("rejects bad names, refused and unknown extensions", async () => {
    expect((await call(ana, "publish_file", { name: "../x.csv", content: "a" })).text).toMatch(/isn't a usable file name/);
    expect((await call(ana, "publish_file", { name: "page.html", content: "<b>" })).text).toMatch(/publish_app/);
    expect((await call(ana, "publish_file", { name: "thing.exe", content: "x" })).text).toMatch(/isn't a shareable type/);
    expect((await call(ana, "publish_file", { name: "empty.txt", content: "" })).text).toMatch(/content is empty/);
  });

  it("shares a CSV: team link, listed, inspectable, viewer renders a table, team download works", async () => {
    const r = await call(ana, "publish_file", { name: "q2.csv", title: "Q2 numbers", content: "region,total\nNA,300\nEMEA,100\n" });
    expect(r.isError).toBe(false);
    const id = idOf(r.text);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(r.text).toContain(`${BASE}/apps/${id}`);
    expect(r.text).toContain(`/admin/files/${id}/q2.csv`);

    const list = (await call(ana, "list_apps")).text;
    expect(list).toMatch(/Q2 numbers \[team, file, csv, <1 KB\]/);

    const got = (await call(bob, "get_app", { id })).text;
    expect(got).toContain("[file]");
    expect(got).toContain("q2.csv · text/csv");
    expect(got).not.toContain("```html");

    // no session → 401 on the team route; with one → the bytes + headers
    expect((await fetch(`${BASE}/admin/files/${id}/q2.csv`)).status).toBe(401);
    const s = await login();
    const dl = await fetch(`${BASE}/admin/files/${id}/q2.csv`, { headers: { cookie: s.cookie } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-disposition")).toBe('inline; filename="q2.csv"');
    expect(dl.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(dl.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const etag = dl.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await dl.text()).toBe("region,total\nNA,300\nEMEA,100\n");
    const notMod = await fetch(`${BASE}/admin/files/${id}/q2.csv`, { headers: { cookie: s.cookie, "if-none-match": etag } });
    expect(notMod.status).toBe(304);

    // the team frame renders the viewer: a synthetic `file` panel for Setoku.table
    const frame = await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: s.cookie } });
    expect(frame.status).toBe(200);
    const html = await frame.text();
    const data = setokuOf(html);
    expect(data.panels.file.columns).toEqual(["region", "total"]);
    expect(data.panels.file.rows).toEqual([
      { region: "NA", total: "300" },
      { region: "EMEA", total: "100" },
    ]);
    expect(html).toContain("Setoku.table('t','file'");
    // the frame carries no download bar of its own — the chrome does that
    expect(html).not.toContain(`/admin/files/${id}/q2.csv`);

    // the /apps/<id>/files/… shape is NOT a file route (the SPA owns /apps/*)
    const spa = await fetch(`${BASE}/apps/${id}/files/q2.csv`, { headers: { cookie: s.cookie } });
    expect(spa.headers.get("content-type")).toContain("text/html");
  });

  it("update_app renames a file but refuses html/panels; the file's own author replaces bytes via publish_file", async () => {
    const id = idOf((await call(ana, "publish_file", { name: "memo.md", content: "# Hello\n\nworld" })).text);
    expect((await call(ana, "update_app", { id, html: "<b>x</b>" })).text).toMatch(/shared file, not an app/);
    expect((await call(ana, "update_app", { id, title: "The memo" })).isError).toBe(false);
    expect((await call(ana, "get_app", { id })).text).toContain("# The memo");
    // wrong name on a file record
    expect((await call(ana, "publish_file", { name: "other.md", content: "x", appId: id })).text).toMatch(/Pass name "memo.md"/);
    // replace
    const rep = await call(ana, "publish_file", { name: "memo.md", content: "# Hello again", appId: id });
    expect(rep.isError).toBe(false);
    const s = await login();
    const frame = await (await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: s.cookie } })).text();
    expect(frame).toContain("<h1>Hello again</h1>");
    // not the author → refused
    expect((await call(bob, "publish_file", { name: "memo.md", content: "hijack", appId: id })).text).toMatch(/Only the author/);
  });

  it("binary content rides base64 and an image inlines into the frame", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // a PNG header, enough for the viewer
    const r = await call(ana, "publish_file", { name: "chart.png", content: png.toString("base64"), encoding: "base64" });
    expect(r.isError).toBe(false);
    const id = idOf(r.text);
    const s = await login();
    const dl = await fetch(`${BASE}/admin/files/${id}/chart.png`, { headers: { cookie: s.cookie } });
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await dl.arrayBuffer()).equals(png)).toBe(true);
    const frame = await (await fetch(`${BASE}/admin/frame/${id}`, { headers: { cookie: s.cookie } })).text();
    expect(frame).toContain(`src="data:image/png;base64,${png.toString("base64")}"`);
  });

  it("an svg is stored but only ever served as a download", async () => {
    const id = idOf((await call(ana, "publish_file", { name: "logo.svg", content: "<svg onload=alert(1)></svg>" })).text);
    const s = await login();
    const dl = await fetch(`${BASE}/admin/files/${id}/logo.svg`, { headers: { cookie: s.cookie } });
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="logo.svg"');
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("attachments on an app", () => {
  it("attaches (author-only, lock-gated), lists under get_app/list_apps, serves, and the frame never references it", async () => {
    const app = await call(ana, "publish_app", { title: "Static", html: "<p>hi</p>" });
    const appId = app.text.match(/update_app\("([^"]+)"/)?.[1] ?? "";
    expect(appId).toBeTruthy();
    expect((await call(bob, "publish_file", { name: "notes.txt", content: "x", appId })).text).toMatch(/Only the author/);
    const r = await call(ana, "publish_file", { name: "notes.txt", content: "some notes", appId });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`Attached notes.txt`);
    expect((await call(ana, "get_app", { id: appId })).text).toContain("## attachments");
    expect((await call(ana, "list_apps")).text).toMatch(/Static \[team, static, 1 file\]/);
    const s = await login();
    const frame = await (await fetch(`${BASE}/admin/frame/${appId}`, { headers: { cookie: s.cookie } })).text();
    expect(frame).not.toContain("notes.txt"); // the frame is the template; attachments live in the shell
    const prov = await (await fetch(`${BASE}/admin/api/app_data?id=${appId}`, { headers: { cookie: s.cookie } })).json();
    expect(prov.files.map((f: { name: string }) => f.name)).toEqual(["notes.txt"]);
    const listed = await (await fetch(`${BASE}/admin/api/published`, { headers: { cookie: s.cookie } })).json();
    expect(listed.find((x: { id: string }) => x.id === appId).files.count).toBe(1);
    // lock → no more attachments
    expect((await adminPost("set_locked", { id: appId, locked: true })).status).toBe(200);
    expect((await call(ana, "publish_file", { name: "more.txt", content: "y", appId })).text).toMatch(/locked/);
  });

  it("unpublish_app is author-only", async () => {
    const id = idOf((await call(ana, "publish_file", { name: "mine.txt", content: "x" })).text);
    expect((await call(bob, "unpublish_app", { id })).text).toMatch(/Only the author/);
    expect((await call(ana, "unpublish_app", { id })).isError).toBe(false);
    const s = await login();
    expect((await fetch(`${BASE}/admin/files/${id}/mine.txt`, { headers: { cookie: s.cookie } })).status).toBe(404);
  });
});

describe("upload URL — PUT /u/<nonce>", () => {
  it("mints a one-time URL; nothing is published until the bytes land; then the file is live", async () => {
    const r = await call(ana, "publish_file", { name: "big.csv", title: "Big one" });
    expect(r.isError).toBe(false);
    const url = uploadUrlOf(r.text);
    expect(url).toMatch(new RegExp(`^${BASE}/u/[0-9a-f]{64}$`));
    expect(r.text).toContain(`curl -fsS -T "./big.csv" "${url}"`);
    const id = idOf(r.text);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    // not yet: list/get/frame all say no
    expect((await call(ana, "list_apps")).text).not.toContain("Big one");
    expect((await call(ana, "get_app", { id })).isError).toBe(true);
    expect((await fetch(url, { method: "GET" })).status).toBe(405);

    const body = "a,b\n" + Array.from({ length: 200 }, (_, i) => `${i},${i * 2}`).join("\n") + "\n";
    const put = await fetch(url, { method: "PUT", body });
    expect(put.status).toBe(200);
    const j = await put.json();
    expect(j).toMatchObject({ ok: true, id, name: "big.csv", size: Buffer.byteLength(body) });
    expect(j.url).toBe(`${BASE}/apps/${id}`);
    expect((await call(ana, "list_apps")).text).toContain("Big one");
    expect((await call(ana, "get_app", { id })).text).toContain("big.csv");
    // replay → gone
    expect((await fetch(url, { method: "PUT", body: "x" })).status).toBe(404);
    // garbage nonce → 404, same shape
    expect((await fetch(`${BASE}/u/deadbeef`, { method: "PUT", body: "x" })).status).toBe(404);
  });

  it("refuses an over-cap upload by content-length and by streamed size, and an empty one", async () => {
    // by content-length (a normal body sets it): 413, and the nonce is burned
    const r = await call(ana, "publish_file", { name: "huge.zip" });
    const url = uploadUrlOf(r.text);
    const byHeader = await fetch(url, { method: "PUT", body: "z".repeat(UPLOAD_CAP + 1) });
    expect(byHeader.status).toBe(413);
    expect((await fetch(url, { method: "PUT", body: "small" })).status).toBe(404);
    // by streamed size (chunked, no content-length): the server cuts the socket
    // after answering 413 — the client sees the 413 or a reset; either way the
    // nonce is burned and nothing was stored
    const r3 = await call(ana, "publish_file", { name: "huge3.zip", title: "Never lands" });
    const url3 = uploadUrlOf(r3.text);
    const chunk = new Uint8Array(1_000);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        for (let i = 0; i < 6; i++) ctrl.enqueue(chunk);
        ctrl.close();
      },
    });
    const streamed = await fetch(url3, { method: "PUT", body: stream, duplex: "half" } as RequestInit).catch(() => null);
    if (streamed) expect(streamed.status).toBe(413);
    expect((await fetch(url3, { method: "PUT", body: "small" })).status).toBe(404);
    expect((await call(ana, "list_apps")).text).not.toContain("Never lands");
    const r2 = await call(ana, "publish_file", { name: "huge2.zip" });
    const url2 = uploadUrlOf(r2.text);
    const empty = await fetch(url2, { method: "PUT", body: "" });
    expect(empty.status).toBe(400);
    // still usable after an empty attempt (no consume on a benign failure)
    const ok = await fetch(url2, { method: "PUT", body: "zipzip" });
    expect(ok.status).toBe(200);
  }, 20_000);

  it("attaching via upload lands on the app", async () => {
    const app = await call(ana, "publish_app", { title: "With upload", html: "<p>x</p>" });
    const appId = app.text.match(/update_app\("([^"]+)"/)?.[1] ?? "";
    const r = await call(ana, "publish_file", { name: "data.json", appId });
    const url = uploadUrlOf(r.text);
    const put = await fetch(url, { method: "PUT", body: JSON.stringify([{ a: 1 }, { a: 2 }]) });
    expect(put.status).toBe(200);
    expect((await put.json()).url).toBe(`${BASE}/apps/${appId}`);
    expect((await call(ana, "get_app", { id: appId })).text).toContain("data.json · application/json");
  });
});

describe("public surface", () => {
  it("404s while team; after promotion serves the shell, viewer frame and bytes; a password gates all three", async () => {
    const id = idOf((await call(ana, "publish_file", { name: "pub.tsv", content: "x\ty\n1\t2\n" })).text);
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(404);
    expect((await fetch(`${BASE}/p/${id}/files/pub.tsv`)).status).toBe(404);
    expect((await adminPost("set_visibility", { id, visibility: "public" })).status).toBe(200);

    const shell = await fetch(`${BASE}/p/${id}`);
    expect(shell.status).toBe(200);
    const shellHtml = await shell.text();
    expect(shellHtml).toContain(`href="/p/${id}/files/pub.tsv"`);
    expect(shellHtml).toContain("Download pub.tsv");

    const frame = await fetch(`${BASE}/p/${id}/frame`);
    expect(frame.status).toBe(200);
    const data = setokuOf(await frame.text());
    expect(data.panels.file.columns).toEqual(["x", "y"]);

    const dl = await fetch(`${BASE}/p/${id}/files/pub.tsv`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("text/tab-separated-values; charset=utf-8");
    expect(dl.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await dl.text()).toBe("x\ty\n1\t2\n");
    expect((await fetch(`${BASE}/p/${id}/files/nope.tsv`)).status).toBe(404);

    // password → the file sub-path is a JSON 401 without the grant, bytes with it
    expect((await adminPost("set_visibility", { id, visibility: "public", password: "open-sesame" })).status).toBe(200);
    const locked = await fetch(`${BASE}/p/${id}/files/pub.tsv`);
    expect(locked.status).toBe(401);
    expect(locked.headers.get("content-type")).toBe("application/json");
    const unlock = await fetch(`${BASE}/p/${id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=open-sesame",
      redirect: "manual",
    });
    expect(unlock.status).toBe(302);
    const grant = (unlock.headers.get("set-cookie") ?? "").split(";")[0];
    const withGrant = await fetch(`${BASE}/p/${id}/files/pub.tsv`, { headers: { cookie: grant } });
    expect(withGrant.status).toBe(200);
    expect(withGrant.headers.get("cache-control")).toBe("no-store");
  });

  it("an app's attachments are listed in the public shell and served, archived → 404", async () => {
    const app = await call(ana, "publish_app", { title: "Pub app", html: "<p>x</p>" });
    const appId = app.text.match(/update_app\("([^"]+)"/)?.[1] ?? "";
    await call(ana, "publish_file", { name: "att.txt", content: "attached", appId });
    await adminPost("set_visibility", { id: appId, visibility: "public" });
    const shell = await (await fetch(`${BASE}/p/${appId}`)).text();
    expect(shell).toContain(`<footer><span class="muted">Files</span><a href="/p/${appId}/files/att.txt">att.txt`);
    expect(await (await fetch(`${BASE}/p/${appId}/files/att.txt`)).text()).toBe("attached");
    await call(ana, "unpublish_app", { id: appId });
    expect((await fetch(`${BASE}/p/${appId}/files/att.txt`)).status).toBe(404);
  });
});
