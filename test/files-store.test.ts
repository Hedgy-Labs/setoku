// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for lib/files.ts: the file store (put/meta/list/summaries,
 * quotas, pending uploads), the name/mime rules, the CSV/JSON parsers, and the
 * markdown subset renderer. Pure store-level tests on an in-memory SQLite —
 * the HTTP/MCP flows live in test/files-integration.test.ts.
 */
import { describe, it, expect } from "bun:test";
import {
  FileStore,
  FileStoreQuotaError,
  MAX_FILES_PER_PUBLICATION,
  sanitizeFileName,
  mimeForName,
  inlineAllowed,
  fileKind,
  parseDelimited,
  parseJsonTable,
  renderMarkdown,
  decodeBase64Strict,
  sha256Hex,
  REFUSED_EXT,
} from "../plugin/gateway/lib/files";

const NOW = "2026-09-03T10:00:00.000Z";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("file names + mimes", () => {
  it("accepts plain names and rejects paths, dotfiles, and spaces", () => {
    expect(sanitizeFileName("report.csv")).toBe("report.csv");
    expect(sanitizeFileName("  q2-memo_v2.md ")).toBe("q2-memo_v2.md");
    expect(sanitizeFileName("../etc/passwd")).toBeNull();
    expect(sanitizeFileName(".env")).toBeNull();
    expect(sanitizeFileName("my file.csv")).toBeNull();
    expect(sanitizeFileName("a/b.csv")).toBeNull();
    expect(sanitizeFileName("x".repeat(121))).toBeNull();
    expect(sanitizeFileName("")).toBeNull();
  });
  it("derives the mime from the extension and refuses what it doesn't know", () => {
    expect(mimeForName("a.csv")).toBe("text/csv");
    expect(mimeForName("A.PNG")).toBe("image/png");
    expect(mimeForName("memo.md")).toBe("text/markdown");
    expect(mimeForName("thing.exe")).toBeNull();
    expect(mimeForName("noext")).toBeNull();
    expect(REFUSED_EXT.html).toContain("publish_app");
  });
  it("never renders svg/xml/html inline; images, pdf and text may be", () => {
    expect(inlineAllowed("image/svg+xml")).toBe(false);
    expect(inlineAllowed("application/xml")).toBe(false);
    expect(inlineAllowed("image/png")).toBe(true);
    expect(inlineAllowed("application/pdf")).toBe(true);
    expect(inlineAllowed("text/csv")).toBe(true);
    expect(inlineAllowed("application/zip")).toBe(false);
  });
  it("maps mimes to viewer kinds", () => {
    expect(fileKind("text/csv")).toBe("table");
    expect(fileKind("application/json")).toBe("table");
    expect(fileKind("text/markdown")).toBe("markdown");
    expect(fileKind("image/webp")).toBe("image");
    expect(fileKind("application/pdf")).toBe("pdf");
    expect(fileKind("image/svg+xml")).toBe("other");
  });
});

describe("FileStore", () => {
  it("puts, reads back, lists, and summarizes", () => {
    const fs = new FileStore(":memory:");
    const m = fs.put("p1", { name: "a.csv", mime: "text/csv", bytes: bytes("x,y\n1,2\n"), by: "ana", now: NOW });
    expect(m.size).toBe(8);
    expect(m.sha256).toBe(sha256Hex(bytes("x,y\n1,2\n")));
    expect(fs.meta("p1", "a.csv")).toEqual(m);
    expect(new TextDecoder().decode(fs.bytes("p1", "a.csv")!)).toBe("x,y\n1,2\n");
    expect(fs.meta("p1", "nope")).toBeNull();
    expect(fs.bytes("p2", "a.csv")).toBeNull();
    fs.put("p1", { name: "b.png", mime: "image/png", bytes: new Uint8Array(10), by: "ana", now: NOW });
    expect(fs.list("p1").map((f) => f.name)).toEqual(["a.csv", "b.png"]);
    const s = fs.summaries();
    expect(s.get("p1")).toEqual({ count: 2, bytes: 18, first: { name: "a.csv", mime: "text/csv", size: 8 } });
    expect(fs.usage()).toEqual({ files: 2, bytes: 18 });
  });

  it("replacing a same-named file overwrites bytes and counts the old size out", () => {
    const fs = new FileStore(":memory:", { maxTotalBytes: 20 });
    fs.put("p1", { name: "a.txt", mime: "text/plain", bytes: new Uint8Array(15), by: "ana", now: NOW });
    // 15 stored; a 20-byte replacement fits only because the old 15 are released
    fs.put("p1", { name: "a.txt", mime: "text/plain", bytes: new Uint8Array(20), by: "bob", now: "2026-09-03T11:00:00.000Z" });
    expect(fs.list("p1")).toHaveLength(1);
    expect(fs.meta("p1", "a.txt")?.uploadedBy).toBe("bob");
    expect(fs.usage().bytes).toBe(20);
  });

  it("enforces the per-publication count cap and the box-wide byte cap", () => {
    const fs = new FileStore(":memory:", { maxTotalBytes: 100 });
    for (let i = 0; i < MAX_FILES_PER_PUBLICATION; i++)
      fs.put("p1", { name: `f${i}.txt`, mime: "text/plain", bytes: new Uint8Array(1), by: "ana", now: NOW });
    expect(() => fs.put("p1", { name: "one-more.txt", mime: "text/plain", bytes: new Uint8Array(1), by: "ana", now: NOW })).toThrow(
      FileStoreQuotaError,
    );
    // a different publication is fine until the box total bites
    expect(() => fs.put("p2", { name: "big.txt", mime: "text/plain", bytes: new Uint8Array(90), by: "ana", now: NOW })).toThrow(
      /storage is full/,
    );
    fs.put("p2", { name: "ok.txt", mime: "text/plain", bytes: new Uint8Array(80), by: "ana", now: NOW });
    expect(fs.usage().bytes).toBe(100);
  });

  it("pending uploads: live until expiry, single-use on consume", () => {
    const fs = new FileStore(":memory:");
    const u = {
      nonce: "n1",
      publishedId: "p9",
      appId: null,
      name: "r.csv",
      mime: "text/csv",
      title: "Report",
      createdBy: "ana",
      model: null,
      expires: 1_000,
      createdAt: NOW,
    };
    fs.createUpload(u);
    expect(fs.takeUpload("n1", 500)).toEqual(u);
    expect(fs.takeUpload("n1", 1_000)).toBeNull(); // expired
    expect(fs.takeUpload("", 0)).toBeNull();
    expect(fs.takeUpload("n1", 500)).toEqual(u); // not consumed by a read
    expect(fs.consumeUpload("n1")).toBe(true);
    expect(fs.takeUpload("n1", 500)).toBeNull();
    expect(fs.consumeUpload("n1")).toBe(false);
    // claimUpload is delete+return in one statement: the second claim finds nothing
    fs.createUpload(u);
    expect(fs.claimUpload("n1", 500)).toEqual(u);
    expect(fs.claimUpload("n1", 500)).toBeNull();
    fs.createUpload(u);
    expect(fs.claimUpload("n1", 1_000)).toBeNull(); // expired rows aren't claimable
  });
});

describe("parseDelimited", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF, and a BOM", () => {
    const t = parseDelimited('﻿name,note,n\r\n"Smith, J","said ""hi""\nthen left",3\r\nplain,,4\r\n', ",");
    expect(t.columns).toEqual(["name", "note", "n"]);
    expect(t.rows).toEqual([
      { name: "Smith, J", note: 'said "hi"\nthen left', n: "3" },
      { name: "plain", note: "", n: "4" },
    ]);
    expect(t.truncated).toBe(false);
  });
  it("tolerates a missing trailing newline and blank lines; dedupes header cells", () => {
    const t = parseDelimited("a\ta\t\n1\t2\t3\n\n4\t5\t6", "\t");
    expect(t.columns).toEqual(["a", "a_2", "col3"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]).toEqual({ a: "4", a_2: "5", col3: "6" });
  });
  it("stops after maxRows and flags truncation only when more existed", () => {
    const body = Array.from({ length: 5 }, (_, i) => `${i}`).join("\n");
    expect(parseDelimited(`n\n${body}\n`, ",", 5).truncated).toBe(false);
    const t = parseDelimited(`n\n${body}\n`, ",", 3);
    expect(t.rows).toHaveLength(3);
    expect(t.truncated).toBe(true);
  });
  it("a suffixed header never collides with a literal one", () => {
    const t = parseDelimited("a,a,a_2\n1,2,3\n", ",");
    expect(t.columns).toEqual(["a", "a_2", "a_2_2"]);
    expect(t.rows[0]).toEqual({ a: "1", a_2: "2", a_2_2: "3" });
    expect(parseDelimited("col1,,x\n1,2,3\n", ",").columns).toEqual(["col1", "col2", "x"]);
    expect(parseDelimited("col2,,x\n1,2,3\n", ",").columns).toEqual(["col2", "col2_2", "x"]);
  });
  it("empty input → no columns", () => {
    expect(parseDelimited("", ",")).toEqual({ columns: [], rows: [], truncated: false });
  });
});

describe("parseJsonTable", () => {
  it("renders an array of flat objects, unioning keys in first-seen order", () => {
    const t = parseJsonTable('[{"a":1,"b":"x"},{"b":"y","c":null,"d":{"k":1}}]');
    expect(t?.columns).toEqual(["a", "b", "c", "d"]);
    expect(t?.rows[1]).toEqual({ b: "y", c: "", d: '{"k":1}' });
  });
  it("anything else is not a table", () => {
    expect(parseJsonTable('{"a":1}')).toBeNull();
    expect(parseJsonTable("[1,2]")).toBeNull();
    expect(parseJsonTable("[]")).toBeNull();
    expect(parseJsonTable("not json")).toBeNull();
  });
});

describe("renderMarkdown", () => {
  it("renders the subset and escapes everything first", () => {
    const html = renderMarkdown(
      [
        "# Title <b>",
        "",
        "Some *emph* and **bold** with `code <x>` and a [link](https://a.example/?q=1).",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```",
        "<script>alert(1)</script>",
        "```",
        "",
        "| h1 | h2 |",
        "|----|----|",
        "| a  | b  |",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Title &lt;b&gt;</h1>");
    expect(html).toContain("<em>emph</em>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code &lt;x&gt;</code>");
    expect(html).toContain('<a href="https://a.example/?q=1" target="_blank" rel="noopener noreferrer">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
    expect(html).toContain("<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>");
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<script>");
  });
  it("two links in one paragraph, a snake_case word, and & in a query all survive", () => {
    const html = renderMarkdown("see [report](https://a.com/x?a=1&b=2) and [q](https://a.com/y) about churn_rate_v2 here");
    expect(html).toContain('<a href="https://a.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">report</a>');
    expect(html).toContain('<a href="https://a.com/y" target="_blank" rel="noopener noreferrer">q</a>');
    expect(html).toContain("churn_rate_v2");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("&amp;amp;");
  });
  it("refuses javascript: links and leaves them as text", () => {
    const html = renderMarkdown("[x](javascript:alert(1)) and <img onerror=1>");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[x](javascript:alert(1))");
    expect(html).toContain("&lt;img onerror=1&gt;");
  });
});

describe("decodeBase64Strict", () => {
  it("round-trips real base64, tolerating line wraps", () => {
    const raw = Buffer.from("hello, files\n");
    expect(decodeBase64Strict(raw.toString("base64"))?.equals(raw)).toBe(true);
    const wrapped = raw.toString("base64").replace(/(.{4})/g, "$1\n");
    expect(decodeBase64Strict(wrapped)?.equals(raw)).toBe(true);
  });
  it("rejects what Buffer.from would silently mangle", () => {
    expect(decodeBase64Strict("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(decodeBase64Strict("not base64!")).toBeNull();
    expect(decodeBase64Strict("abc")).toBeNull(); // bad length
    expect(decodeBase64Strict("")).toBeNull();
  });
});
