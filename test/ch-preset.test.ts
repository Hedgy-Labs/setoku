// SPDX-License-Identifier: Apache-2.0
/**
 * Drift lock: deploy/bootstrap.sh sizes ClickHouse from the box's RAM via
 * deploy/ch-preset.sh. Two things have to hold, and neither is visible by
 * reading the shell script:
 *
 *   1. a 4 GB box stays on `small`. That is the one mapping we have real
 *      evidence for (weeks of uptime, zero OOM kills), so a later tweak to the
 *      thresholds must not quietly demote it to `tiny`.
 *   2. every name the picker can emit has a matching preset XML. compose
 *      bind-mounts `./deploy/clickhouse/${SETOKU_CH_PRESET}.xml`, so a name
 *      without a file is a box that won't start.
 *
 * Spawns bash on purpose — the picker is shell, and running the real script is
 * the only way to catch a syntax slip in it. ONE spawn for the whole file:
 * process-per-case is enough concurrent load to starve the boot-warm timing in
 * test/event-discovery.test.ts when the full suite runs.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(ROOT, "deploy", "ch-preset.sh");

/** Every RAM figure this file asks about, resolved in a single bash process. */
const INPUTS = [
  "1900", "2900", "3299", "3300", "3814", "7900", "11671", "12000", "15800",
  "24000", "512", "999999", "", "unknown", "3.5G", "-1",
];

const presets: Record<string, string> = await (async () => {
  const script = `. "${SCRIPT}"\n${INPUTS.map(
    (mb) => `printf '%s\\t%s\\n' ${JSON.stringify(mb)} "$(ch_preset_for_ram_mb ${JSON.stringify(mb)})"`,
  ).join("\n")}\n`;
  const proc = Bun.spawn({ cmd: ["bash", "-c", script], stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || err.trim()) throw new Error(`ch-preset.sh failed (${code}): ${err}`);
  return Object.fromEntries(
    out.trim().split("\n").map((line) => {
      const [mb, preset] = line.split("\t");
      return [mb ?? "", preset ?? ""];
    }),
  );
})();

const presetFor = (ramMb: string) => presets[ramMb];

describe("ch-preset.sh", () => {
  // MemTotal as `free -m` reports it, which runs a few percent under the
  // advertised size — these are the numbers the boxes actually print.
  const CASES: [string, string, string][] = [
    ["1900", "tiny", "2 GB box"],
    ["2900", "tiny", "3 GB box — the case tiny.xml exists for"],
    ["3299", "tiny", "just under the boundary"],
    ["3300", "small", "just over the boundary"],
    ["3814", "small", "4 GB box — proven on small, must not demote"],
    ["7900", "small", "8 GB box — the size small.xml was soaked at"],
    ["11671", "small", "12 GB box"],
    ["12000", "roomy", "roomy starts here"],
    ["15800", "roomy", "16 GB box"],
    ["24000", "roomy", "24 GB prototype"],
  ];

  for (const [mb, want, why] of CASES) {
    it(`${mb} MB → ${want} (${why})`, () => {
      expect(presetFor(mb)).toBe(want);
    });
  }

  it("falls back to small on an unreadable RAM figure, never to tiny", () => {
    // A bad reading should land on the fixed default this file replaced, not
    // silently starve ClickHouse on a box that has plenty of memory.
    for (const junk of ["", "unknown", "3.5G", "-1"]) {
      expect(presetFor(junk)).toBe("small");
    }
  });

  it("has a preset XML for every name it can emit", () => {
    const emitted = new Set<string>();
    for (const mb of ["512", "2900", "3814", "7900", "24000", "999999"]) {
      emitted.add(presetFor(mb));
    }
    expect(emitted.size).toBe(3); // tiny | small | roomy — a 4th needs a file + this bump
    for (const name of emitted) {
      const xml = path.join(ROOT, "deploy", "clickhouse", `${name}.xml`);
      expect(fs.existsSync(xml)).toBe(true);
    }
  });

  it("keeps tiny's merge-pool entries under its background_pool_size", () => {
    // ClickHouse's startup sanity check refuses to boot if a
    // number_of_free_entries_in_pool_to_* value is >= background_pool_size, so
    // a box on `tiny` would crash-loop rather than start degraded.
    const xml = fs.readFileSync(
      path.join(ROOT, "deploy", "clickhouse", "tiny.xml"),
      "utf8",
    );
    const pool = Number(/<background_pool_size>(\d+)</.exec(xml)?.[1]);
    expect(pool).toBeGreaterThan(0);
    const entries = [...xml.matchAll(/<number_of_free_entries_in_pool_to_\w+>(\d+)</g)];
    expect(entries.length).toBe(3);
    for (const [, value] of entries) expect(Number(value)).toBeLessThan(pool);
  });
});
