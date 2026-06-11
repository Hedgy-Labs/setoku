// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 1.4: dependency license audit.
 *
 * Policy (README Phase 1):
 *   - GPL/AGPL (copyleft; LGPL excluded) anywhere in node_modules → FAIL.
 *   - Unknown/unparseable license in the BUNDLED set (production closure of
 *     plugin/package.json dependencies) → FAIL; elsewhere (dev-only) → WARN.
 *
 * Writes a TSV report to license-report.tsv (uploaded as a CI artifact).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const REPORT = path.join(ROOT, "license-report.tsv");

interface Pkg {
  name: string;
  version: string;
  license: string;
  deps: string[];
}

function licenseOf(pkg: Record<string, unknown>): string {
  const l = pkg.license as unknown;
  if (typeof l === "string" && l.trim()) return l;
  if (l && typeof l === "object" && "type" in (l as object))
    return String((l as { type?: string }).type ?? "UNKNOWN");
  const ls = pkg.licenses as { type?: string }[] | undefined;
  if (Array.isArray(ls) && ls.length)
    return ls.map((x) => x.type ?? "?").join(" OR ");
  return "UNKNOWN";
}

function collect(dir: string, out: Map<string, Pkg>) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (entry.startsWith("@")) {
      collect(full, out);
      continue;
    }
    const pkgJson = path.join(full, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        const name = String(pkg.name ?? entry);
        out.set(name, {
          name,
          version: String(pkg.version ?? "?"),
          license: licenseOf(pkg),
          deps: Object.keys(pkg.dependencies ?? {}),
        });
      } catch {
        out.set(entry, { name: entry, version: "?", license: "UNPARSEABLE", deps: [] });
      }
    }
    collect(path.join(full, "node_modules"), out);
  }
}

const installed = new Map<string, Pkg>();
collect(path.join(ROOT, "node_modules"), installed);

// Production closure: what the plugin actually distributes/runs.
const pluginPkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "plugin", "package.json"), "utf8"),
);
const bundled = new Set<string>();
const queue: string[] = Object.keys(pluginPkg.dependencies ?? {});
while (queue.length) {
  const name = queue.pop()!;
  if (bundled.has(name)) continue;
  bundled.add(name);
  const pkg = installed.get(name);
  if (pkg) queue.push(...pkg.deps);
}

const isCopyleft = (l: string) => /\bA?GPL\b/i.test(l.replace(/LGPL[^ ]*/gi, ""));
const isUnknown = (l: string) => l === "UNKNOWN" || l === "UNPARSEABLE";

const fail: string[] = [];
const warn: string[] = [];
const lines = ["package\tversion\tlicense\tset"];
for (const pkg of [...installed.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const set = bundled.has(pkg.name) ? "bundled" : "dev";
  lines.push(`${pkg.name}\t${pkg.version}\t${pkg.license}\t${set}`);
  const id = `${pkg.name}@${pkg.version} (${set}): ${pkg.license}`;
  if (isCopyleft(pkg.license)) fail.push(id);
  else if (isUnknown(pkg.license)) (set === "bundled" ? fail : warn).push(id);
}

fs.writeFileSync(REPORT, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(
  `\n${installed.size} packages scanned (${bundled.size} in the bundled set). Report: license-report.tsv`,
);
if (warn.length) console.log(`\nWARN — unknown license, dev-only:\n  ${warn.join("\n  ")}`);
if (fail.length) {
  console.error(`\nFAIL — policy violations:\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
console.log("check-licenses: clean (no GPL/AGPL; bundled set fully licensed).");
