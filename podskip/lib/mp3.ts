// SPDX-License-Identifier: Apache-2.0
// Minimal MP3 frame walker. Two jobs:
//   1. duration of a file (sum of frame durations — VBR-safe),
//   2. splitting a file into <~N-byte chunks on frame boundaries with exact
//      start-time offsets, so each chunk can be transcribed independently and
//      its segment timestamps shifted back into episode time.
// Layer III only (every podcast MP3); ID3v2 tags are skipped.

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

interface Frame {
  offset: number;
  length: number;
  durationSec: number;
}

function id3v2Size(buf: Uint8Array): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  // syncsafe integer
  return 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
}

function frameAt(buf: Uint8Array, i: number): Frame | null {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (buf[i + 1] >> 1) & 0x03; // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
  const sampleIdx = (buf[i + 2] >> 2) & 0x03;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) return null;
  const padding = (buf[i + 2] >> 1) & 0x01;
  const mpeg1 = versionBits === 3;
  const bitrate = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][sampleIdx];
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  if (length < 24 || i + length > buf.length) return null;
  return { offset: i, length, durationSec: samples / sampleRate };
}

export function* walkFrames(buf: Uint8Array): Generator<Frame> {
  let i = id3v2Size(buf);
  while (i < buf.length - 4) {
    const f = frameAt(buf, i);
    if (f) {
      yield f;
      i += f.length;
    } else {
      i += 1; // resync: scan forward byte-by-byte
    }
  }
}

export function mp3Duration(buf: Uint8Array): number {
  let total = 0;
  for (const f of walkFrames(buf)) total += f.durationSec;
  return total;
}

export interface Mp3Chunk {
  bytes: Uint8Array;
  startSec: number;
}

/** Split into frame-aligned chunks of at most maxBytes each. */
export function chunkMp3(buf: Uint8Array, maxBytes = 20 * 1024 * 1024): Mp3Chunk[] {
  const chunks: Mp3Chunk[] = [];
  let chunkStartByte = -1;
  let chunkStartSec = 0;
  let clock = 0;
  let end = 0;
  for (const f of walkFrames(buf)) {
    if (chunkStartByte === -1) {
      chunkStartByte = f.offset;
      chunkStartSec = clock;
    }
    if (f.offset + f.length - chunkStartByte > maxBytes && f.offset > chunkStartByte) {
      chunks.push({ bytes: buf.subarray(chunkStartByte, f.offset), startSec: chunkStartSec });
      chunkStartByte = f.offset;
      chunkStartSec = clock;
    }
    clock += f.durationSec;
    end = f.offset + f.length;
  }
  if (chunkStartByte !== -1 && end > chunkStartByte) {
    chunks.push({ bytes: buf.subarray(chunkStartByte, end), startSec: chunkStartSec });
  }
  return chunks;
}
