// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compareVersions, notesBetween, parseReleaseNotes, releaseNotesFor } from "../plugin/gateway/lib/release-notes";
import { formatEvent } from "../plugin/gateway/lib/notify";

const MD = `# Setoku release notes

Intro prose that is not a note.

## v0.12.0
- Newest thing with **bold**
- Second thing that wraps
  onto a new line

## v0.10.0
- Ten

## v0.9.0
- Nine
`;

describe("release notes", () => {
  it("parses sections + bullets (wrapped lines joined, prose ignored)", () => {
    const n = parseReleaseNotes(MD);
    expect(n.map((x) => x.version)).toEqual(["0.12.0", "0.10.0", "0.9.0"]);
    expect(n[0].bullets).toEqual(["Newest thing with **bold**", "Second thing that wraps onto a new line"]);
  });

  it("compares versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "0.10.0")).toBe(-1);
  });

  it("selects every version in (previous, current], newest first", () => {
    const n = parseReleaseNotes(MD);
    expect(notesBetween(n, "0.9.0", "0.12.0").map((x) => x.version)).toEqual(["0.12.0", "0.10.0"]);
    expect(notesBetween(n, "0.10.0", "0.10.0")).toEqual([]);
    expect(notesBetween(n, null, "0.10.0").map((x) => x.version)).toEqual(["0.10.0", "0.9.0"]);
  });

  it("the deploy notice carries the notes as Slack mrkdwn (headed per version only when several)", () => {
    const n = parseReleaseNotes(MD);
    const one = formatEvent({ kind: "deploy", version: "0.12.0", previous: "0.10.0", notes: notesBetween(n, "0.10.0", "0.12.0") });
    expect(one).toBe("🚀 *Setoku updated* to v0.12.0 (was v0.10.0)\n• Newest thing with *bold*\n• Second thing that wraps onto a new line");
    const two = formatEvent({ kind: "deploy", version: "0.12.0", previous: "0.9.0", notes: notesBetween(n, "0.9.0", "0.12.0") });
    expect(two).toContain("\n*v0.12.0*\n• Newest");
    expect(two).toContain("\n*v0.10.0*\n• Ten");
    // no notes → just the version line, as before
    expect(formatEvent({ kind: "deploy", version: "0.12.0", previous: "0.11.0", notes: [] })).toBe("🚀 *Setoku updated* to v0.12.0 (was v0.11.0)");
  });

  it("caps a long digest", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join("\n");
    const n = parseReleaseNotes(`## v1.0.0\n${many}\n`);
    const msg = formatEvent({ kind: "deploy", version: "1.0.0", previous: "0.9.0", notes: n });
    expect(msg).toContain("• item 11");
    expect(msg).not.toContain("• item 12");
    expect(msg).toContain("…and 8 more");
  });

  it("the shipped RELEASES.md parses and covers the manifest version", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    const shipped = releaseNotesFor(null, manifest.version);
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped[0].version).toBe(manifest.version);
  });
});
