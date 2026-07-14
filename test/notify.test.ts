// SPDX-License-Identifier: Apache-2.0
// Activity notifications (issue #63): the event → Slack-text rendering, the
// env-var-name webhook resolution (the URL never lands in config), and the
// best-effort POST that must never throw into its caller.
import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNotifyWebhook } from "../plugin/gateway/lib/config";
import { formatEvent, notifyActivity, type ActivityEvent } from "../plugin/gateway/lib/notify";
import { formatBytes } from "../plugin/gateway/lib/format";

const dirs: string[] = [];
function projectWith(config: Record<string, unknown>, env?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-notify-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, ".setoku"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".setoku", "config.json"), JSON.stringify(config));
  if (env) fs.writeFileSync(path.join(dir, ".env"), env);
  return dir;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("formatEvent", () => {
  it("renders a published app with its link and panel count", () => {
    const t = formatEvent({ kind: "app_published", title: "Sales", url: "/apps/x", by: "al@co", panels: 3 });
    expect(t).toContain("App published");
    expect(t).toContain("Sales");
    expect(t).toContain("al@co");
    expect(t).toContain("3 live panels");
    expect(t).toContain("/apps/x");
  });

  it("renders an update with the author note and the changed facets", () => {
    const t = formatEvent({
      kind: "app_updated",
      title: "Sales",
      url: "/apps/x",
      by: "bo@co",
      changed: ["content", "data"],
      message: "Added a weekly revenue panel",
    });
    expect(t).toContain("App updated");
    expect(t).toContain("Added a weekly revenue panel");
    expect(t).toContain("content, data");
  });

  it("omits the note line when no message was given", () => {
    const t = formatEvent({ kind: "app_updated", title: "S", url: "/p/x", by: "b", changed: ["title"] });
    expect(t).not.toContain(">"); // the blockquote note prefix
    expect(t).toContain("title");
  });

  it("renders a deploy with the box name and prior version", () => {
    const t = formatEvent({ kind: "deploy", version: "0.21.0", previous: "0.20.0", box: "campsh" });
    expect(t).toContain("0.21.0");
    expect(t).toContain("was v0.20.0");
    expect(t).toContain("campsh");
  });

  it("renders an egress alert in the vendor's billing unit (decimal GB)", () => {
    const t = formatEvent({
      kind: "egress_alert",
      day: "2026-07-09",
      bytes: 12_400_000_000,
      thresholdBytes: 10e9,
      box: "campsh",
    });
    expect(t).toContain("mirror egress");
    expect(t).toContain("12 GB"); // ≥10 GB rounds to whole GB
    expect(t).toContain("10 GB/day alert threshold");
    expect(t).toContain("2026-07-09");
    expect(t).toContain("campsh");
  });

  it("formatBytes is honest at every tier (shared by Slack text and the admin card)", () => {
    expect(formatBytes(0)).toBe("0"); // never a phantom floor
    expect(formatBytes(300)).toBe("<1 KB");
    expect(formatBytes(3_000)).toBe("3 KB");
    expect(formatBytes(40_000_000)).toBe("40 MB"); // a 0.04 GB threshold reads as MB, not "0.0 GB"
    expect(formatBytes(400_000_000)).toBe("0.4 GB");
    expect(formatBytes(1_230_000_000)).toBe("1.2 GB"); // <10 GB keeps a decimal
    expect(formatBytes(12_400_000_000)).toBe("12 GB");
  });
});

describe("resolveNotifyWebhook", () => {
  const load = (dir: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, ".setoku", "config.json"), "utf8"));

  it("defaults to SETOKU_NOTIFY_WEBHOOK from process env", () => {
    const dir = projectWith({});
    process.env.SETOKU_NOTIFY_WEBHOOK = "https://hooks.example/default";
    try {
      expect(resolveNotifyWebhook(dir, { ...load(dir) } as any)).toBe("https://hooks.example/default");
    } finally {
      delete process.env.SETOKU_NOTIFY_WEBHOOK;
    }
  });

  it("reads a custom env-var name from config, falling back to the project .env", () => {
    const dir = projectWith(
      { notifications: { slackWebhookEnv: "MY_HOOK" } },
      "MY_HOOK=https://hooks.example/from-env-file\n",
    );
    expect(resolveNotifyWebhook(dir, load(dir) as any)).toBe("https://hooks.example/from-env-file");
  });

  it("returns null when no webhook is configured (notifications are opt-in)", () => {
    const dir = projectWith({});
    expect(resolveNotifyWebhook(dir, load(dir) as any)).toBeNull();
  });
});

describe("notifyActivity", () => {
  async function capture(event: ActivityEvent, config: Record<string, unknown>, envName: string) {
    let received: { text?: string } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = (await req.json()) as { text?: string };
        return new Response("ok");
      },
    });
    const url = `http://localhost:${server.port}/hook`;
    const dir = projectWith(config);
    process.env[envName] = url;
    try {
      await notifyActivity(dir, event);
    } finally {
      delete process.env[envName];
      server.stop(true);
    }
    return received as { text?: string } | null;
  }

  it("POSTs the formatted text to the configured webhook", async () => {
    const event: ActivityEvent = { kind: "app_published", title: "Sales", url: "/p/x", by: "al", panels: 1 };
    const received = await capture(event, {}, "SETOKU_NOTIFY_WEBHOOK");
    expect(received).not.toBeNull();
    expect(received!.text).toBe(formatEvent(event));
  });

  it("is a silent no-op — and never throws — when no webhook is configured", async () => {
    const dir = projectWith({});
    // Must resolve without throwing even though there's nowhere to send.
    await expect(
      notifyActivity(dir, { kind: "deploy", version: "1.0.0", previous: "0.9.0" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a transport failure (unreachable webhook) without throwing", async () => {
    const dir = projectWith({});
    process.env.SETOKU_NOTIFY_WEBHOOK = "http://127.0.0.1:1/nope"; // refused
    try {
      await expect(
        notifyActivity(dir, { kind: "deploy", version: "1.0.0", previous: "0.9.0" }),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.SETOKU_NOTIFY_WEBHOOK;
    }
  });
});
