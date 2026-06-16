#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Build the /admin React bundle (web/app/main.tsx → web/dist/app.js) with Bun's
 * native bundler — no Vite, one toolchain. The output is committed (like app.css)
 * so a deploy box serves it without running a build. Rebuild: bun run build:admin-js
 */
import path from "node:path";

const dir = import.meta.dir;
const result = await Bun.build({
  entrypoints: [path.join(dir, "app", "main.tsx")],
  outdir: path.join(dir, "dist"),
  naming: "app.js",
  minify: true,
  target: "browser",
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.error(`built ${path.join(dir, "dist", "app.js")}`);
