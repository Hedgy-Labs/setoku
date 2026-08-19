// SPDX-License-Identifier: Apache-2.0
// Whisper transcription via Groq or OpenAI (whichever key is set; Groq wins
// when both are). Long files are split on MP3 frame boundaries so every
// chunk stays under the providers' upload limit, then segment timestamps are
// shifted back into episode time.
import { chunkMp3 } from "./mp3.ts";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface Provider {
  name: string;
  url: string;
  model: string;
  key: string;
}

export function transcriptionProvider(env = process.env): Provider | null {
  if (env.GROQ_API_KEY) {
    return {
      name: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
      key: env.GROQ_API_KEY,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      name: "openai",
      url: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
      key: env.OPENAI_API_KEY,
    };
  }
  return null;
}

// Both providers reject uploads over ~25MB; stay comfortably under.
const MAX_CHUNK_BYTES = 18 * 1024 * 1024;

async function transcribeChunk(p: Provider, bytes: Uint8Array): Promise<TranscriptSegment[]> {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], "chunk.mp3", { type: "audio/mpeg" }));
  form.append("model", p.model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const res = await fetch(p.url, {
    method: "POST",
    headers: { authorization: `Bearer ${p.key}` },
    body: form,
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`${p.name} transcription failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { segments?: { start: number; end: number; text: string }[] };
  return (json.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
}

export async function transcribe(
  mp3: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<TranscriptSegment[]> {
  const p = transcriptionProvider();
  if (!p) {
    throw new Error(
      "no transcription key configured — set GROQ_API_KEY (free tier works) or OPENAI_API_KEY",
    );
  }
  const chunks = mp3.byteLength <= MAX_CHUNK_BYTES
    ? [{ bytes: mp3, startSec: 0 }]
    : chunkMp3(mp3, MAX_CHUNK_BYTES);
  if (chunks.length === 0) throw new Error("no MP3 frames found in downloaded audio");
  const all: TranscriptSegment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const segs = await transcribeChunk(p, chunks[i].bytes);
    for (const s of segs) {
      all.push({ start: s.start + chunks[i].startSec, end: s.end + chunks[i].startSec, text: s.text });
    }
  }
  onProgress?.(chunks.length, chunks.length);
  return all;
}
