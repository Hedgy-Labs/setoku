// SPDX-License-Identifier: Apache-2.0
// RSS feed fetching + a small tolerant parser (no XML dependency; podcast
// feeds are messy but the fields we need are shallow and item-scoped).

export interface ShowConfig {
  id: string;
  title: string;
  feed: string;
}

export interface Episode {
  guid: string;
  title: string;
  pubDate: string; // ISO
  durationSec: number | null;
  audioUrl: string;
  audioType: string;
  audioBytes: number | null;
}

export interface Show extends ShowConfig {
  image: string | null;
  description: string | null;
  episodes: Episode[];
}

const decodeEntities = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

const tag = (xml: string, name: string): string | null => {
  // matches <name ...>inner</name> or self-closing; first occurrence
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : null;
};

const attr = (xml: string, name: string, attrName: string): string | null => {
  const m = xml.match(new RegExp(`<${name}\\s([^>]*?)/?>`, "i"));
  if (!m) return null;
  const a = m[1].match(new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, "i"));
  return a ? decodeEntities(a[1]) : null;
};

export const parseDuration = (raw: string | null): number | null => {
  if (!raw) return null;
  const t = raw.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};

export function parseFeed(cfg: ShowConfig, xml: string, maxEpisodes = 25): Show {
  const channelHead = xml.slice(0, xml.search(/<item[\s>]/i) === -1 ? xml.length : xml.search(/<item[\s>]/i));
  const image =
    attr(channelHead, "itunes:image", "href") ??
    tag(channelHead.match(/<image>[\s\S]*?<\/image>/i)?.[0] ?? "", "url");

  const episodes: Episode[] = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const item = m[0];
    const audioUrl = attr(item, "enclosure", "url");
    if (!audioUrl) continue;
    const title = tag(item, "title") ?? "(untitled)";
    const guid = tag(item, "guid") ?? audioUrl;
    const pubRaw = tag(item, "pubDate");
    const pub = pubRaw ? new Date(pubRaw) : null;
    episodes.push({
      guid,
      title,
      pubDate: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : "",
      durationSec: parseDuration(tag(item, "itunes:duration")),
      audioUrl,
      audioType: attr(item, "enclosure", "type") ?? "audio/mpeg",
      audioBytes: Number(attr(item, "enclosure", "length")) || null,
    });
    if (episodes.length >= maxEpisodes) break;
  }

  return {
    ...cfg,
    title: tag(channelHead, "title") ?? cfg.title,
    image,
    description: tag(channelHead, "itunes:summary") ?? tag(channelHead, "description"),
    episodes,
  };
}

const FEED_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; show: Show }>();

export async function fetchShow(cfg: ShowConfig): Promise<Show> {
  const hit = cache.get(cfg.id);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.show;
  const res = await fetch(cfg.feed, {
    headers: { "user-agent": "podskip/0.1 (personal podcast player)" },
    redirect: "follow",
  });
  if (!res.ok) {
    if (hit) return hit.show; // serve stale over failing
    throw new Error(
      `feed for "${cfg.title}" returned HTTP ${res.status} — if this persists, ` +
        `the feed URL in shows.json may be wrong or moved`,
    );
  }
  const show = parseFeed(cfg, await res.text());
  cache.set(cfg.id, { at: Date.now(), show });
  return show;
}

/** Episode lookup that only trusts URLs that came out of a parsed feed —
 *  keeps the /audio route from becoming an open proxy. */
export function findEpisode(show: Show, guid: string): Episode | null {
  return show.episodes.find((e) => e.guid === guid) ?? null;
}
