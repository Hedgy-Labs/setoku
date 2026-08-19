# PodSkip

A minimal self-hosted podcast player that **skips the ads**. One Bun process,
no build step, installable on your phone as a PWA.

How it works: when you play an episode, the server downloads it, transcribes
it (Whisper via Groq or OpenAI), asks Claude to mark the advertising
time-ranges in the transcript, and caches the result — a one-time pass of a
few cents per episode. The player then jumps over those ranges during
playback (and paints them amber on the seek bar). Playback starts
immediately; skipping kicks in as soon as the ad map is ready (a ~30–60 min
episode maps in a couple of minutes).

Pod Save America and The Daily are preconfigured in `shows.json` — add any
show by appending its RSS feed URL there.

## Run it

```bash
cd podskip
bun install

export ANTHROPIC_API_KEY=...   # ad classification
export GROQ_API_KEY=...        # transcription (or OPENAI_API_KEY; Groq free tier works)

bun run start                  # → http://localhost:4321
```

Without keys the app still works as a plain podcast player — ad mapping is
just disabled (the UI says so).

## Put it on your phone

The player is a PWA: open it in the phone's browser → share/menu →
**Add to Home Screen**. It runs full-screen with lock-screen controls
(Media Session API).

Two ways to reach it from the phone:

- **Tailscale (easiest):** `tailscale serve 4321` on the machine running
  PodSkip gives you an HTTPS URL reachable from your phone.
- Any other HTTPS reverse proxy (Caddy, cloudflared, …) pointed at port 4321.

Plain `http://<laptop-ip>:4321` on the same Wi-Fi also plays fine, but iOS
requires HTTPS for the full PWA treatment.

## Notes

- **Which ads get caught:** host-read sponsor segments, dynamically inserted
  ads, and cross-promos — anything visible in the transcript. Boundaries err
  toward including the whole ad without cutting content.
- Audio is streamed through the server (byte-range passthrough to the
  podcast CDN, or from the local copy once downloaded). Nothing is served
  publicly; run it for yourself.
- Episode ad maps live in `podskip/data/cache/`, downloaded audio in
  `podskip/data/audio/` (both gitignored). Delete a cache file to re-process
  an episode.
- Feed URLs and provider details (upload limits, model names) churn — if a
  feed errors or transcription rejects a file, check the URL/model against
  the provider's current docs.

## Development

```bash
bun test              # unit tests (MP3 frame parser, RSS parsing, range merging)
bun run test:e2e      # real-Chromium test: plays synthesized audio, asserts the skips
bun run start:fixtures  # fixture mode — canned show + tone audio, no network/keys
bun run typecheck
```
