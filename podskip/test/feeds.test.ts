// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { parseFeed, parseDuration } from "../lib/feeds.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Example Show &amp; Friends</title>
  <description><![CDATA[A show about examples]]></description>
  <itunes:image href="https://example.test/art.jpg"/>
  <item>
    <title><![CDATA[Episode Two: The &quot;Sequel&quot;]]></title>
    <guid isPermaLink="false">ep-2</guid>
    <pubDate>Tue, 18 Aug 2026 09:00:00 +0000</pubDate>
    <itunes:duration>1:02:03</itunes:duration>
    <enclosure url="https://cdn.example.test/ep2.mp3?x=1&amp;y=2" length="52428800" type="audio/mpeg"/>
  </item>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <pubDate>Mon, 17 Aug 2026 09:00:00 +0000</pubDate>
    <itunes:duration>1800</itunes:duration>
    <enclosure url="https://cdn.example.test/ep1.mp3" length="1234" type="audio/mpeg"/>
  </item>
  <item>
    <title>No audio — should be skipped</title>
    <guid>ep-0</guid>
  </item>
</channel>
</rss>`;

const cfg = { id: "example", title: "fallback", feed: "https://example.test/feed" };

describe("feeds", () => {
  test("parses channel metadata", () => {
    const show = parseFeed(cfg, XML);
    expect(show.title).toBe("Example Show & Friends");
    expect(show.image).toBe("https://example.test/art.jpg");
  });

  test("parses items with CDATA, entities, enclosures", () => {
    const show = parseFeed(cfg, XML);
    expect(show.episodes.length).toBe(2); // enclosure-less item dropped
    const [e2, e1] = show.episodes;
    expect(e2.title).toBe('Episode Two: The "Sequel"');
    expect(e2.guid).toBe("ep-2");
    expect(e2.audioUrl).toBe("https://cdn.example.test/ep2.mp3?x=1&y=2");
    expect(e2.durationSec).toBe(3723);
    expect(e2.audioBytes).toBe(52428800);
    expect(new Date(e2.pubDate).getUTCDate()).toBe(18);
    expect(e1.durationSec).toBe(1800);
  });

  test("respects maxEpisodes", () => {
    expect(parseFeed(cfg, XML, 1).episodes.length).toBe(1);
  });

  test("duration formats", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("2:05")).toBe(125);
    expect(parseDuration("1:00:05")).toBe(3605);
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration("abc")).toBeNull();
  });
});
