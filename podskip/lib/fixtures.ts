// SPDX-License-Identifier: Apache-2.0
// Fixture mode (SURFER_FIXTURES=1): canned shows + a synthesized WAV with
// known "ad" ranges, so the player and skip logic can be exercised end-to-end
// with no network, no keys, and no real podcast audio.
import type { Show } from "./feeds.ts";
import type { AdRange } from "./ads.ts";

export const FIXTURE_ADS: AdRange[] = [
  { start: 10, end: 20, kind: "sponsor_read", note: "fixture ad one" },
  { start: 40, end: 50, kind: "inserted_ad", note: "fixture ad two" },
];

export const FIXTURE_DURATION = 60;

export const fixtureShows = (): Show[] => [
  {
    id: "fixture-show",
    title: "Fixture Podcast",
    feed: "fixture://feed",
    image: null,
    description: "Synthesized audio for testing",
    episodes: [
      {
        guid: "fixture-ep-1",
        title: "Test Episode",
        pubDate: new Date(0).toISOString(),
        durationSec: FIXTURE_DURATION,
        audioUrl: "fixture://tone",
        audioType: "audio/wav",
        audioBytes: null,
      },
    ],
  },
];

/** 60s mono 16-bit 8kHz WAV. Content beeps at 440Hz; "ad" ranges beep at 880Hz. */
export function fixtureWav(): Uint8Array {
  const rate = 8000;
  const samples = FIXTURE_DURATION * rate;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const inAd = FIXTURE_ADS.some((a) => t >= a.start && t < a.end);
    const freq = inAd ? 880 : 440;
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * t) * 8000), true);
  }
  return new Uint8Array(buf);
}
