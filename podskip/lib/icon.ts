// SPDX-License-Identifier: Apache-2.0
// Renders the 180x180 apple-touch-icon PNG at runtime (cached), so the repo
// stays all-text. Same art as web/icon.svg: play triangle + skip bar on stone.
import { deflateSync } from "node:zlib";

const W = 180, H = 180;

function render(): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * W + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 0x1c, 0x19, 0x17);
  for (let y = 50; y <= 130; y++) for (let x = 63; x <= 122; x++) {
    const half = 40 * (1 - (x - 63) / (122 - 63));
    if (Math.abs(y - 90) <= half) set(x, y, 0xfa, 0xfa, 0xf9);
  }
  for (let y = 50; y <= 130; y++) for (let x = 130; x <= 142; x++) set(x, y, 0xb4, 0x53, 0x09);

  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W); iv.setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}

let cached: Uint8Array | null = null;
export function appleTouchIcon(): Uint8Array {
  return (cached ??= render());
}
