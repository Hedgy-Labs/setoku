// SPDX-License-Identifier: Apache-2.0
// Surfer — a minimal self-hosted podcast player that maps and skips ads.
// One Bun process: static PWA + JSON API + Range-capable audio serving.
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import showsConfig from "./shows.json";
import { fetchShow, findEpisode, type Show, type ShowConfig } from "./lib/feeds.ts";
import { jobState, startJob, audioPath } from "./lib/pipeline.ts";
import { transcriptionProvider } from "./lib/transcribe.ts";
import { fixtureShows, fixtureWav, FIXTURE_ADS, FIXTURE_DURATION } from "./lib/fixtures.ts";
import { appleTouchIcon } from "./lib/icon.ts";

const FIXTURES = process.env.SURFER_FIXTURES === "1";
const PORT = Number(process.env.SURFER_PORT ?? 4321);
const WEB_DIR = join(import.meta.dir, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function loadShows(): Promise<Show[]> {
  if (FIXTURES) return fixtureShows();
  const cfgs = showsConfig.shows as ShowConfig[];
  return Promise.all(
    cfgs.map(async (cfg) => {
      try {
        return await fetchShow(cfg);
      } catch (err) {
        return {
          ...cfg,
          image: null,
          description: `⚠ ${err instanceof Error ? err.message : String(err)}`,
          episodes: [],
        } satisfies Show;
      }
    }),
  );
}

async function showById(id: string): Promise<Show | null> {
  return (await loadShows()).find((s) => s.id === id) ?? null;
}

/** Serve bytes honoring a single Range header (what <audio> sends). */
function serveRange(bytes: Uint8Array | null, file: string | null, type: string, rangeHeader: string | null): Response {
  const size = bytes ? bytes.byteLength : Bun.file(file!).size;
  const src = (start: number, end: number) =>
    bytes ? new Response(bytes.subarray(start, end + 1) as Uint8Array<ArrayBuffer>) : new Response(Bun.file(file!).slice(start, end + 1));
  const common = { "accept-ranges": "bytes", "content-type": type, "cache-control": "no-store" };
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response(src(0, size - 1).body, { headers: { ...common, "content-length": String(size) } });
  }
  let start: number, end: number;
  if (m[1] === "") {
    // suffix range: last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  return new Response(src(start, end).body, {
    status: 206,
    headers: {
      ...common,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    },
  });
}

/** Pass a Range request through to the podcast CDN when we have no local copy yet. */
async function proxyRemoteAudio(url: string, rangeHeader: string | null): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": "surfer/0.1 (personal podcast player)" };
  if (rangeHeader) headers.range = rangeHeader;
  const upstream = await fetch(url, { headers, redirect: "follow" });
  if (!upstream.ok && upstream.status !== 206) {
    return json({ error: `upstream audio returned HTTP ${upstream.status}` }, 502);
  }
  const out = new Headers({ "accept-ranges": "bytes", "cache-control": "no-store" });
  for (const h of ["content-type", "content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/shows") {
      const shows = await loadShows();
      // decorate episodes with processing state so the list renders chips
      const out = [];
      for (const s of shows) {
        const episodes = [];
        for (const e of s.episodes) {
          const st = FIXTURES
            ? { state: "ready", ads: FIXTURE_ADS, durationSec: FIXTURE_DURATION }
            : await jobState(s.id, e.guid);
          episodes.push({ ...e, job: st });
        }
        out.push({ ...s, episodes });
      }
      return json({
        shows: out,
        fixtures: FIXTURES,
        keys: {
          transcription: FIXTURES || transcriptionProvider() !== null,
          anthropic: FIXTURES || Boolean(process.env.ANTHROPIC_API_KEY),
        },
      });
    }

    if (path === "/api/status") {
      const showId = url.searchParams.get("show") ?? "";
      const guid = url.searchParams.get("guid") ?? "";
      if (FIXTURES) return json({ state: "ready", ads: FIXTURE_ADS, durationSec: FIXTURE_DURATION });
      return json(await jobState(showId, guid));
    }

    if (path === "/api/process" && req.method === "POST") {
      const { show: showId, guid } = (await req.json()) as { show: string; guid: string };
      if (FIXTURES) return json({ state: "ready", ads: FIXTURE_ADS, durationSec: FIXTURE_DURATION });
      const missing: string[] = [];
      if (!transcriptionProvider()) missing.push("GROQ_API_KEY or OPENAI_API_KEY");
      if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
      if (missing.length) return json({ state: "error", error: `missing keys: ${missing.join(", ")}` }, 400);
      const show = await showById(showId);
      const ep = show && findEpisode(show, guid);
      if (!show || !ep) return json({ state: "error", error: "unknown episode" }, 404);
      startJob(show, ep);
      return json(await jobState(showId, guid));
    }

    if (path === "/audio") {
      const showId = url.searchParams.get("show") ?? "";
      const guid = url.searchParams.get("guid") ?? "";
      const range = req.headers.get("range");
      if (FIXTURES) return serveRange(fixtureWav(), null, "audio/wav", range);
      const show = await showById(showId);
      const ep = show && findEpisode(show, guid);
      if (!show || !ep) return json({ error: "unknown episode" }, 404);
      const local = audioPath(showId, guid);
      if (existsSync(local)) return serveRange(null, local, ep.audioType, range);
      return proxyRemoteAudio(ep.audioUrl, range);
    }

    if (path === "/apple-touch-icon.png") {
      return new Response(appleTouchIcon() as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "image/png", "cache-control": "max-age=86400" },
      });
    }

    // static PWA
    const rel = path === "/" ? "/index.html" : path;
    const file = join(WEB_DIR, rel);
    if (file.startsWith(WEB_DIR) && existsSync(file)) {
      return new Response(Bun.file(file), {
        headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[surfer] listening on http://localhost:${server.port}` +
    (FIXTURES ? " (FIXTURE MODE — canned shows, no network)" : ""),
);
if (!FIXTURES) {
  if (!transcriptionProvider())
    console.log("[surfer] note: set GROQ_API_KEY or OPENAI_API_KEY to enable transcription");
  if (!process.env.ANTHROPIC_API_KEY)
    console.log("[surfer] note: set ANTHROPIC_API_KEY to enable ad classification");
}
