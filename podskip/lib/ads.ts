// SPDX-License-Identifier: Apache-2.0
// Ad classification: the episode transcript (with timestamps) goes to Claude,
// which returns the time ranges that are advertising. Structured output keeps
// the response machine-parseable.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TranscriptSegment } from "./transcribe.ts";

export interface AdRange {
  start: number;
  end: number;
  kind: string;
  note: string;
}

const AdReportSchema = z.object({
  ads: z.array(
    z.object({
      start_seconds: z.number(),
      end_seconds: z.number(),
      kind: z.enum(["sponsor_read", "inserted_ad", "cross_promo"]),
      note: z.string(),
    }),
  ),
});

const fmtClock = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

/** Merge overlapping/near-adjacent ranges, clamp to the episode, drop slivers. */
export function normalizeRanges(ads: AdRange[], durationSec: number | null, joinGapSec = 3): AdRange[] {
  const sorted = ads
    .map((a) => ({
      ...a,
      start: Math.max(0, a.start),
      end: durationSec ? Math.min(a.end, durationSec) : a.end,
    }))
    .filter((a) => a.end - a.start >= 5)
    .sort((a, b) => a.start - b.start);
  const out: AdRange[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.start <= last.end + joinGapSec) {
      last.end = Math.max(last.end, a.end);
      if (a.kind !== last.kind) last.kind = "ads";
    } else {
      out.push({ ...a });
    }
  }
  return out;
}

export async function classifyAds(
  segments: TranscriptSegment[],
  showTitle: string,
  episodeTitle: string,
  durationSec: number | null,
): Promise<AdRange[]> {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system:
      "You mark advertising time-ranges in podcast transcripts so a player can skip them. " +
      "Mark: host-read sponsor segments (including the lead-in like \"this show is brought to you by\" " +
      "and the outro of the read), dynamically inserted/programmatic ads (abrupt topic changes " +
      "pitching a product, often mid-episode), and cross-promotions for OTHER shows or the network's " +
      "subscription offering. Do NOT mark: the show's own intro/theme, editorial content that merely " +
      "mentions a company, or listener-question segments. Boundaries should align with the transcript's " +
      "segment timestamps, erring on including the full ad but never cutting real content. " +
      "If there are no ads, return an empty list.",
    messages: [
      {
        role: "user",
        content:
          `Show: ${showTitle}\nEpisode: ${episodeTitle}\n` +
          (durationSec ? `Duration: ${fmtClock(durationSec)}\n` : "") +
          `Transcript (each line is [start-end] in seconds):\n\n${transcript}`,
      },
    ],
    output_config: { format: zodOutputFormat(AdReportSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("ad classification returned unparseable output");
  return normalizeRanges(
    parsed.ads.map((a) => ({ start: a.start_seconds, end: a.end_seconds, kind: a.kind, note: a.note })),
    durationSec,
  );
}
