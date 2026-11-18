// SPDX-License-Identifier: Apache-2.0
/**
 * App previews: render an app's frame in a headless Chromium and hand the agent
 * a screenshot plus what went wrong (JS errors, CSP-blocked fetches, failed
 * fonts/images, panel errors, overflow). Agents publish blind; this is how
 * they see the page before a person opens it.
 *
 * Shape (docker-compose.yml, profile `preview`): Chromium runs in its OWN
 * container (`preview`, chromedp/headless-shell) on an internal-only network
 * with no secrets and no internet. The gateway drives it over CDP. The browser
 * never fetches anything: the gateway builds the exact frame document the box
 * would serve (same CSP + sandbox, panels from cache) and fulfils the one
 * navigation itself; every other request is aborted.
 *
 * Load guards — a preview costs a browser tab, so nothing here may be
 * amplifiable by a chatty agent or a loop:
 *  - identical documents are served from a short result cache (free),
 *  - a per-identity token bucket and a box-wide one,
 *  - ONE render at a time with a short queue (busy → a clear "retry in ~Ns"),
 *  - a hard per-render timeout, and the container's own memory/pid limits.
 * Panels render cache-only, so a preview never queries the lake.
 */
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import type { Browser } from "playwright-core";

export type Viewport = "desktop" | "mobile";
const VIEWPORTS: Record<Viewport, { width: number; height: number; scale: number }> = {
  desktop: { width: 1280, height: 860, scale: 1 },
  mobile: { width: 390, height: 844, scale: 2 },
};
/** Screenshots are clipped to this many CSS px tall (a 20k-px page is mostly tokens). */
const MAX_SHOT_HEIGHT = 4_000;
const RENDER_TIMEOUT_MS = 20_000;
/** Settle time after load + fonts, for template scripts / first paint. */
const SETTLE_MS = 600;
const RESULT_TTL_MS = 2 * 60_000;
const MAX_QUEUE = 2;
/** The origin the document is "served" from inside the browser. `.invalid` can
 *  never resolve, so even a mis-fulfilled request goes nowhere. */
const DOC_URL = "http://app.setoku-preview.invalid/frame";

export interface PreviewDiagnostics {
  width: number;
  height: number;
  clipped: boolean;
  errors: string[];
  console: string[];
  blocked: string[];
  fonts: string[];
  images: string[];
  media: string[];
  overflowPx: number;
  blank: boolean;
}

export interface PreviewShot {
  jpeg: Buffer;
  diagnostics: PreviewDiagnostics;
  cached: boolean;
}

/** Thrown when a guard says no; `message` is written for the agent. */
export class PreviewLimitError extends Error {}

/** A minimal token bucket (same idea as http.ts's, kept local and keyed). */
function bucket(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; last: number }>();
  return {
    /** Seconds until a token is available (0 = spent one now). */
    take(key: string, now = Date.now()): number {
      const s = b.get(key) ?? { tokens: capacity, last: now };
      s.tokens = Math.min(capacity, s.tokens + ((now - s.last) / 1000) * perSec);
      s.last = now;
      b.set(key, s);
      if (s.tokens >= 1) {
        s.tokens -= 1;
        return 0;
      }
      return Math.ceil((1 - s.tokens) / perSec);
    },
    refund(key: string): void {
      const s = b.get(key);
      if (s) s.tokens = Math.min(capacity, s.tokens + 1);
    },
  };
}

export interface PreviewerOptions {
  /** CDP endpoint of the renderer, e.g. http://preview:9222. */
  cdpUrl: string;
  /** Per-identity bucket: burst / sustained per minute. */
  perUser?: { burst: number; perMinute: number };
  /** Box-wide bucket. */
  perBox?: { burst: number; perMinute: number };
}

export class Previewer {
  private readonly cdpUrl: string;
  private browser: Promise<Browser> | null = null;
  private readonly results = new Map<string, { at: number; shot: Omit<PreviewShot, "cached"> }>();
  private readonly inFlight = new Map<string, Promise<Omit<PreviewShot, "cached">>>();
  private readonly userBucket: ReturnType<typeof bucket>;
  private readonly boxBucket: ReturnType<typeof bucket>;
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  /** Last probe result; the tool is offered only while the renderer answers. */
  available = false;

  constructor(opts: PreviewerOptions) {
    this.cdpUrl = opts.cdpUrl.replace(/\/+$/, "");
    const u = opts.perUser ?? { burst: 6, perMinute: 2 };
    const b = opts.perBox ?? { burst: 20, perMinute: 6 };
    this.userBucket = bucket(u.burst, u.perMinute / 60);
    this.boxBucket = bucket(b.burst, b.perMinute / 60);
  }

  /** Chrome's DevTools HTTP endpoint refuses a Host header that isn't an IP or
   *  localhost (DNS-rebinding guard), so a compose service name must be
   *  resolved to its IP before connecting. */
  private async endpoint(): Promise<string> {
    const u = new URL(this.cdpUrl);
    if (!/^(\d+\.){3}\d+$/.test(u.hostname) && u.hostname !== "localhost") {
      const { address } = await dns.lookup(u.hostname, { family: 4 });
      u.hostname = address;
    }
    return u.toString().replace(/\/+$/, "");
  }

  /** Is the renderer up? Cheap (one HTTP GET); http.ts polls it. */
  async probe(): Promise<boolean> {
    try {
      const r = await fetch(`${await this.endpoint()}/json/version`, { signal: AbortSignal.timeout(2_000) });
      this.available = r.ok;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private async connect(): Promise<Browser> {
    if (!this.browser) {
      const { chromium } = await import("playwright-core");
      this.browser = this.endpoint()
        .then((ep) => chromium.connectOverCDP(ep, { timeout: 5_000 }))
        .then((br) => {
          br.on("disconnected", () => (this.browser = null));
          return br;
        })
        .catch((e) => {
          this.browser = null;
          throw e;
        });
    }
    return this.browser;
  }

  private async slot(): Promise<() => void> {
    if (this.running >= 1) {
      if (this.waiters.length >= MAX_QUEUE)
        throw new PreviewLimitError("The previewer is busy with other renders. Retry in ~15s.");
      await new Promise<void>((ok) => this.waiters.push(ok));
    }
    this.running++;
    return () => {
      this.running--;
      this.waiters.shift()?.();
    };
  }

  /**
   * Render `html` (a complete frame document) under `csp` at `viewport`.
   * `identity` keys the per-user budget. Cache hits and joins of an identical
   * in-flight render spend nothing.
   */
  async render(html: string, csp: string, viewport: Viewport, identity: string): Promise<PreviewShot> {
    const key = createHash("sha256").update(viewport).update("\0").update(csp).update("\0").update(html).digest("hex");
    const now = Date.now();
    for (const [k, v] of this.results) if (now - v.at > RESULT_TTL_MS) this.results.delete(k);
    const hit = this.results.get(key);
    if (hit) return { ...hit.shot, cached: true };
    const joining = this.inFlight.get(key);
    if (joining) return { ...(await joining), cached: true };

    const wait = this.userBucket.take(identity, now);
    if (wait) throw new PreviewLimitError(`Preview limit reached for you — next one in ~${wait}s. Batch your edits, then preview once.`);
    const boxWait = this.boxBucket.take("box", now);
    if (boxWait) {
      this.userBucket.refund(identity);
      throw new PreviewLimitError(`This box is rendering a lot of previews right now — next one in ~${boxWait}s.`);
    }

    const p = (async () => {
      const release = await this.slot();
      try {
        return await this.renderNow(html, csp, viewport);
      } finally {
        release();
      }
    })();
    this.inFlight.set(key, p);
    try {
      const shot = await p;
      this.results.set(key, { at: Date.now(), shot });
      return { ...shot, cached: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async renderNow(html: string, csp: string, viewport: Viewport): Promise<Omit<PreviewShot, "cached">> {
    const vp = VIEWPORTS[viewport];
    const browser = await this.connect();
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const timer = setTimeout(() => void ctx.close().catch(() => {}), RENDER_TIMEOUT_MS);
    try {
      const page = await ctx.newPage();
      const errors: string[] = [];
      const consoleLines: string[] = [];
      page.on("pageerror", (e) => errors.push(oneLine(`${e.name}: ${e.message}`)));
      page.on("console", (m) => {
        const t = m.type();
        if (t === "error" || t === "warning") consoleLines.push(`${t}: ${oneLine(m.text())}`);
      });
      // Before any page script: record CSP violations (what the template tried
      // to fetch) and answer the Setoku.state bridge locally — there is no
      // parent shell here, and an 8s state timeout would stall the render.
      await page.addInitScript(() => {
        const w = window as unknown as { __previewBlocked: string[] };
        w.__previewBlocked = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          const ev = e as SecurityPolicyViolationEvent;
          w.__previewBlocked.push(`${ev.effectiveDirective}: ${ev.blockedURI || "(inline)"}`);
        });
        window.addEventListener("message", (e) => {
          const m = e.data as { __setoku_state_req?: boolean; id?: number; op?: string } | null;
          if (!m || m.__setoku_state_req !== true) return;
          const result = m.op === "list" ? [] : m.op === "get" ? null : true;
          window.postMessage({ __setoku_state_res: true, id: m.id, result }, "*");
        });
      });
      // The ONE document is fulfilled here; everything else is refused.
      await page.route("**/*", (route) =>
        route.request().url() === DOC_URL
          ? route.fulfill({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
              body: html,
            })
          : route.abort("blockedbyclient"),
      );
      await page.goto(DOC_URL, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS - 3_000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(SETTLE_MS);

      const probe = await page.evaluate(() => {
        const w = window as unknown as { __previewBlocked?: string[] };
        const fonts: string[] = [];
        document.fonts.forEach((f) => {
          if (f.status === "error") fonts.push(`${f.family.replace(/^["']|["']$/g, "")} failed to load`);
        });
        const images = [...document.images]
          .filter((i) => i.complete && i.naturalWidth === 0)
          .map((i) => `<img> failed: ${(i.getAttribute("src") || "").slice(0, 80)}`);
        const media = [...document.querySelectorAll("audio,video")]
          .filter((m) => (m as HTMLMediaElement).error)
          .map((m) => `<${m.tagName.toLowerCase()}> error ${(m as HTMLMediaElement).error?.code}: ${((m as HTMLMediaElement).currentSrc || m.getAttribute("src") || "").slice(0, 60)}`);
        const doc = document.documentElement;
        return {
          blocked: w.__previewBlocked ?? [],
          fonts,
          images,
          media,
          width: doc.scrollWidth,
          height: doc.scrollHeight,
          overflowPx: Math.max(0, doc.scrollWidth - window.innerWidth),
          blank: !(document.body?.innerText ?? "").trim() && !document.querySelector("img,svg,canvas,video"),
        };
      });
      const clipped = probe.height > MAX_SHOT_HEIGHT;
      const jpeg = await page.screenshot({
        type: "jpeg",
        quality: 70,
        fullPage: true,
        ...(clipped ? { clip: { x: 0, y: 0, width: vp.width, height: MAX_SHOT_HEIGHT } } : {}),
        timeout: 8_000,
      });
      return {
        jpeg,
        diagnostics: {
          width: probe.width,
          height: probe.height,
          clipped,
          errors: dedupe(errors),
          console: dedupe(consoleLines),
          blocked: dedupe(probe.blocked),
          fonts: probe.fonts,
          images: probe.images,
          media: probe.media,
          overflowPx: probe.overflowPx,
          blank: probe.blank,
        },
      };
    } finally {
      clearTimeout(timer);
      await ctx.close().catch(() => {});
    }
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const dedupe = (xs: string[]): string[] => [...new Set(xs)].slice(0, 15);
