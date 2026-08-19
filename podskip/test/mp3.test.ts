// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mp3Duration, chunkMp3, walkFrames } from "../lib/mp3.ts";

// Synthesize a CBR MPEG1 Layer III stream: 128kbps @ 44100Hz, no padding.
// Frame length = floor(1152/8 * 128000 / 44100) = 417 bytes; 1152/44100 s each.
function makeFrames(n: number, withId3 = false): Uint8Array {
  const frameLen = 417;
  const id3 = withId3 ? 60 : 0;
  const buf = new Uint8Array(id3 + n * frameLen);
  if (withId3) {
    buf.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3" v2.3
    // syncsafe size = 50 (total tag = 10 header + 50)
    buf[9] = 50;
    // fill tag body with 0xFF junk to make sure we don't false-sync inside it
    buf.fill(0xff, 10, 60);
  }
  for (let i = 0; i < n; i++) {
    const o = id3 + i * frameLen;
    buf[o] = 0xff;
    buf[o + 1] = 0xfb; // MPEG1 Layer III, no CRC
    buf[o + 2] = 0x90; // bitrate idx 9 (128k), sample idx 0 (44100), no padding
    buf[o + 3] = 0x00;
  }
  return buf;
}

describe("mp3", () => {
  test("duration of a CBR stream", () => {
    const buf = makeFrames(1000);
    expect([...walkFrames(buf)].length).toBe(1000);
    expect(mp3Duration(buf)).toBeCloseTo((1000 * 1152) / 44100, 3);
  });

  test("skips ID3v2 tag without false-syncing", () => {
    const buf = makeFrames(100, true);
    expect([...walkFrames(buf)].length).toBe(100);
  });

  test("resyncs after garbage bytes", () => {
    const clean = makeFrames(10);
    const buf = new Uint8Array(clean.length + 33);
    buf.set(clean.subarray(0, 417 * 5));
    buf.fill(0x00, 417 * 5, 417 * 5 + 33); // torn bytes mid-file
    buf.set(clean.subarray(417 * 5), 417 * 5 + 33);
    expect([...walkFrames(buf)].length).toBe(10);
  });

  test("chunking is frame-aligned with correct time offsets", () => {
    const buf = makeFrames(1000); // 417,000 bytes
    const chunks = chunkMp3(buf, 100_000); // ~239 frames per chunk
    expect(chunks.length).toBe(5);
    // every chunk starts with a valid sync word
    for (const c of chunks) {
      expect(c.bytes[0]).toBe(0xff);
      expect(c.bytes.length % 417).toBe(0);
    }
    // total bytes preserved
    expect(chunks.reduce((n, c) => n + c.bytes.length, 0)).toBe(buf.length);
    // second chunk's start time == frames-in-first-chunk * frame duration
    const framesInFirst = chunks[0].bytes.length / 417;
    expect(chunks[1].startSec).toBeCloseTo((framesInFirst * 1152) / 44100, 4);
    // chunk start times strictly increase
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startSec).toBeGreaterThan(chunks[i - 1].startSec);
  });

  test("small file stays one chunk", () => {
    const buf = makeFrames(50);
    const chunks = chunkMp3(buf, 100_000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startSec).toBe(0);
  });
});
