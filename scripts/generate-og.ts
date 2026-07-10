// SPDX-License-Identifier: Apache-2.0
//
// Generate the Open Graph card (site/assets/og.png, 1200×630) by rendering an
// HTML version of the site masthead — the sprout, the NAME line — in the system
// Chrome and screenshotting it. Re-run after changing the sprout art or tagline:
//
//   bun scripts/generate-og.ts
//
// The PNG is a committed artifact (the static site has no build step), like the
// admin bundles. Requires Google Chrome at its default macOS path.
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const OUT = resolve(import.meta.dir, "../site/assets/og.png");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Same sprout as site/index.html's masthead (pre.fig) — keep them in sync.
const SPROUT = ` .*%@@@%*.
:@@@@@@@@@*
@@@@@@@@@@@:     :*%%*.
@@@@@@@@@@@@:   %@@@@@@*
.%@@@@@@@@@@@. %@@@@@@@@
  :**%%@@@@@@*.@@@@@@@%:
        .:*@@%%@@%**:.
            :%%:.
            .@@.
            :@@:
            %@@:
           .@@@.
           %@@@.
          .@@@@`;

const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      :root {
        --paper: #ffffff;
        --ink: #201f1a;
        --ink-soft: #423f36;
        --ink-faint: #6a675c;
        --line-soft: rgba(32, 31, 26, 0.08);
        --sage-d: #33543d;
        --mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas,
          "Liberation Mono", monospace;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html { -webkit-font-smoothing: antialiased; }
      body {
        width: 1200px;
        height: 630px;
        background: var(--paper);
        color: var(--ink);
        font-family: var(--mono);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 34px;
        position: relative;
      }
      .runline {
        position: absolute;
        left: 60px;
        right: 60px;
        display: flex;
        justify-content: space-between;
        font-size: 19px;
        letter-spacing: 0.02em;
        color: var(--ink-faint);
      }
      .runline.top { top: 40px; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
      .runline.bot { bottom: 40px; padding-top: 14px; border-top: 1px solid var(--line-soft); }
      pre.fig {
        color: var(--sage-d);
        font-size: 21px;
        line-height: 1.15;
        white-space: pre;
      }
      .nameline { font-size: 30px; color: var(--ink-soft); }
      .nameline b { color: var(--ink); font-weight: 700; }
    </style>
  </head>
  <body>
    <div class="runline top"><span>SETOKU</span><span>User Manual</span><span>SETOKU.COM</span></div>
    <pre class="fig">${SPROUT}</pre>
    <div class="nameline"><b>setoku</b> &mdash; make any AI fluent in your company data</div>
    <div class="runline bot"><span>Hedgy Labs</span><span>2026</span><span>SETOKU</span></div>
  </body>
</html>`;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
await page.setContent(html, { waitUntil: "networkidle" });
// render at 2x, emit at CSS pixels: exactly 1200×630 (what the platforms
// expect) with the crisper antialiasing of the retina render
await page.screenshot({ path: OUT, scale: "css" });
await browser.close();
console.log(`✓ wrote ${OUT}`);
