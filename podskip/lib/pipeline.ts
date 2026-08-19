// SPDX-License-Identifier: Apache-2.0
// Per-episode processing: download → transcribe → classify → cache to disk.
// One episode at a time (transcription providers rate-limit; simplicity wins).
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mp3Duration } from "./mp3.ts";
import { transcribe } from "./transcribe.ts";
import { classifyAds, type AdRange } from "./ads.ts";
import type { Episode, Show } from "./feeds.ts";

export type JobState =
  | { state: "idle" }
  | { state: "queued" }
  | { state: "downloading" }
  | { state: "transcribing"; progress: string }
  | { state: "classifying" }
  | { state: "ready"; ads: AdRange[]; durationSec: number }
  | { state: "error"; error: string };

export interface CacheEntry {
  showId: string;
  guid: string;
  episodeTitle: string;
  durationSec: number;
  ads: AdRange[];
  processedAt: string;
  segmentCount: number;
}

const DATA_DIR = process.env.SURFER_DATA ?? join(import.meta.dir, "..", "data");
const CACHE_DIR = join(DATA_DIR, "cache");
const AUDIO_DIR = join(DATA_DIR, "audio");

export const episodeKey = (showId: string, guid: string): string =>
  `${showId}--${Bun.hash(guid).toString(16)}`;

export const audioPath = (showId: string, guid: string): string =>
  join(AUDIO_DIR, `${episodeKey(showId, guid)}.mp3`);

const cachePath = (showId: string, guid: string): string =>
  join(CACHE_DIR, `${episodeKey(showId, guid)}.json`);

const live = new Map<string, JobState>();
let queue: Promise<void> = Promise.resolve();

export async function readCache(showId: string, guid: string): Promise<CacheEntry | null> {
  const f = Bun.file(cachePath(showId, guid));
  return (await f.exists()) ? ((await f.json()) as CacheEntry) : null;
}

export async function jobState(showId: string, guid: string): Promise<JobState> {
  const running = live.get(episodeKey(showId, guid));
  if (running) return running;
  const cached = await readCache(showId, guid);
  if (cached) return { state: "ready", ads: cached.ads, durationSec: cached.durationSec };
  return { state: "idle" };
}

export function startJob(show: Show, ep: Episode): void {
  const key = episodeKey(show.id, ep.guid);
  const current = live.get(key);
  if (current && current.state !== "error") return; // already queued/running
  live.set(key, { state: "queued" });
  queue = queue.then(() => runJob(show, ep)).catch(() => {});
}

async function runJob(show: Show, ep: Episode): Promise<void> {
  const key = episodeKey(show.id, ep.guid);
  if (await readCache(show.id, ep.guid)) {
    live.delete(key);
    return;
  }
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    mkdirSync(AUDIO_DIR, { recursive: true });

    live.set(key, { state: "downloading" });
    const aPath = audioPath(show.id, ep.guid);
    if (!existsSync(aPath)) {
      const res = await fetch(ep.audioUrl, {
        headers: { "user-agent": "surfer/0.1 (personal podcast player)" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`audio download failed: HTTP ${res.status}`);
      await Bun.write(aPath + ".part", res);
      const { renameSync } = await import("node:fs");
      renameSync(aPath + ".part", aPath);
    }
    const mp3 = new Uint8Array(await Bun.file(aPath).arrayBuffer());
    const durationSec = ep.durationSec ?? Math.round(mp3Duration(mp3));

    live.set(key, { state: "transcribing", progress: "0/?" });
    const segments = await transcribe(mp3, (done, total) =>
      live.set(key, { state: "transcribing", progress: `${done}/${total}` }),
    );
    if (segments.length === 0) throw new Error("transcription returned no segments");

    live.set(key, { state: "classifying" });
    const ads = await classifyAds(segments, show.title, ep.title, durationSec);

    const entry: CacheEntry = {
      showId: show.id,
      guid: ep.guid,
      episodeTitle: ep.title,
      durationSec,
      ads,
      processedAt: new Date().toISOString(),
      segmentCount: segments.length,
    };
    await Bun.write(cachePath(show.id, ep.guid), JSON.stringify(entry, null, 2));
    live.delete(key);
    console.log(`[surfer] ${show.title} — "${ep.title}": ${ads.length} ad range(s) mapped`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[surfer] processing failed for "${ep.title}":`, msg);
    live.set(key, { state: "error", error: msg });
  }
}
