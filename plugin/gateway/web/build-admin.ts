#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Build the React bundles with Bun's native bundler — no Vite, one toolchain:
 *   web/app/main.tsx        → web/dist/app.js          (the /admin app)
 *   web/app/file-viewer.tsx → web/dist/file-viewer.js  (the grid on a public
 *                                                       /p/<id> tabular file)
 * The output is committed (like app.css) so a deploy box serves it without
 * running a build. Rebuild: bun run build:admin-js
 */
import path from "node:path";

const dir = import.meta.dir;
for (const [entry, out] of [
  ["main.tsx", "app.js"],
  ["file-viewer.tsx", "file-viewer.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [path.join(dir, "app", entry)],
    outdir: path.join(dir, "dist"),
    naming: out,
    minify: true,
    target: "browser",
    sourcemap: "none",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    for (const m of result.logs) console.error(m);
    process.exit(1);
  }
  console.error(`built ${path.join(dir, "dist", out)}`);
}
