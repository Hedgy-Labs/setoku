// SPDX-License-Identifier: Apache-2.0
// PodSkip player. Plain JS, no build step. The interesting part is the skip
// engine: on timeupdate, if the playhead is inside a known ad range, jump to
// the end of that range.
"use strict";

const $ = (id) => document.getElementById(id);
const audio = $("audio");

const state = {
  shows: [],
  current: null, // { showId, guid, title, showTitle, image, durationSec }
  ads: [],
  pollTimer: null,
  rate: Number(localStorage.getItem("podskip.rate") || 1),
};

const fmt = (s) => {
  if (!Number.isFinite(s)) return "–:––";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
};

// ---- skip engine ---------------------------------------------------------
// Exposed on window for the e2e test to introspect.
function adAt(t, ads) {
  for (const a of ads) if (t >= a.start && t < a.end - 0.25) return a;
  return null;
}
window.__podskip = { adAt, state, audio, skips: 0 };

function maybeSkip() {
  // !audio.seeking: while a skip's seek is still in flight, timeupdate can
  // re-fire with the old (in-ad) position — don't double-jump.
  const ad = adAt(audio.currentTime, state.ads);
  if (ad && !audio.seeking) {
    audio.currentTime = ad.end;
    window.__podskip.skips++;
    toast(`Skipped ${Math.round(ad.end - ad.start)}s of ads`);
  }
}
audio.addEventListener("timeupdate", () => {
  maybeSkip();
  paintProgress();
  savePosition();
});
// A paused seek into an ad fires no timeupdate — catch it on seeked.
audio.addEventListener("seeked", () => { maybeSkip(); paintProgress(); });

// ---- toast ---------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---- position persistence ------------------------------------------------
const posKey = () => state.current && `podskip.pos.${state.current.showId}.${state.current.guid}`;
let lastSaved = 0;
function savePosition() {
  if (!state.current || Date.now() - lastSaved < 3000) return;
  lastSaved = Date.now();
  localStorage.setItem(posKey(), String(audio.currentTime));
}

// ---- rendering -----------------------------------------------------------
function chip(job) {
  if (!job) return "";
  const map = {
    ready: ["chip-ready", (j) => (j.ads.length ? `${j.ads.length} ad${j.ads.length > 1 ? "s" : ""} mapped` : "no ads found")],
    idle: ["", () => "not processed"],
    queued: ["chip-busy", () => "queued"],
    downloading: ["chip-busy", () => "downloading"],
    transcribing: ["chip-busy", (j) => `transcribing ${j.progress || ""}`],
    classifying: ["chip-busy", () => "finding ads"],
    error: ["chip-err", () => "failed — tap to retry"],
  };
  const [cls, label] = map[job.state] || ["", () => job.state];
  return `<span class="chip ${cls}">${label(job)}</span>`;
}

function render() {
  const main = $("main");
  main.innerHTML = "";
  for (const show of state.shows) {
    const div = document.createElement("div");
    div.className = "show";
    div.innerHTML = `
      <div class="show-head">
        ${show.image ? `<img src="${show.image}" alt="">` : ""}
        <div><h2></h2>${show.episodes.length ? "" : `<div class="show-err"></div>`}</div>
      </div>`;
    div.querySelector("h2").textContent = show.title;
    if (!show.episodes.length) {
      div.querySelector(".show-err").textContent = show.description || "no episodes found";
    }
    for (const ep of show.episodes) {
      const btn = document.createElement("button");
      btn.className = "ep";
      const date = ep.pubDate ? new Date(ep.pubDate).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      btn.innerHTML = `
        <div class="ep-body">
          <div class="ep-title"></div>
          <div class="ep-sub">${date}${ep.durationSec ? " · " + fmt(ep.durationSec) : ""}</div>
        </div>${chip(ep.job)}`;
      btn.querySelector(".ep-title").textContent = ep.title;
      btn.addEventListener("click", () => playEpisode(show, ep));
      div.appendChild(btn);
    }
    main.appendChild(div);
  }
}

function paintAds() {
  const wrap = $("seek-ads");
  wrap.innerHTML = "";
  const dur = state.current?.durationSec || audio.duration;
  if (!dur) return;
  for (const a of state.ads) {
    const m = document.createElement("div");
    m.className = "ad-mark";
    m.style.left = (a.start / dur) * 100 + "%";
    m.style.width = Math.max(0.5, ((a.end - a.start) / dur) * 100) + "%";
    $("seek").appendChild(m);
    wrap.appendChild(document.createTextNode("")); // keep container for clearing
  }
}

function clearAdMarks() {
  document.querySelectorAll(".ad-mark").forEach((n) => n.remove());
}

function paintProgress() {
  const dur = audio.duration || state.current?.durationSec || 0;
  $("t-cur").textContent = fmt(audio.currentTime);
  $("t-dur").textContent = fmt(dur);
  $("seek-fill").style.width = dur ? (audio.currentTime / dur) * 100 + "%" : "0";
  $("btn-play").textContent = audio.paused ? "▶" : "⏸";
}

// ---- playback ------------------------------------------------------------
async function playEpisode(show, ep) {
  state.current = {
    showId: show.id, guid: ep.guid, title: ep.title, showTitle: show.title,
    image: show.image, durationSec: ep.durationSec,
  };
  state.ads = ep.job && ep.job.state === "ready" ? ep.job.ads : [];
  clearAdMarks();

  $("player").hidden = false;
  $("p-episode").textContent = ep.title;
  updateMeta();
  const art = $("p-art");
  if (show.image) { art.src = show.image; art.hidden = false; } else art.hidden = true;

  audio.src = `/audio?show=${encodeURIComponent(show.id)}&guid=${encodeURIComponent(ep.guid)}`;
  audio.playbackRate = state.rate;
  const saved = Number(localStorage.getItem(posKey()) || 0);
  if (saved > 5) audio.currentTime = saved;
  try { await audio.play(); } catch { /* autoplay policy — user taps play */ }
  paintAds();
  setMediaSession();

  // Ad map already on disk? Nothing to do.
  if (ep.job && ep.job.state === "ready") return;

  // Kick off ad mapping if it hasn't run yet, then poll until ready.
  if (!ep.job || ep.job.state === "idle" || ep.job.state === "error") {
    const res = await fetch("/api/process", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ show: show.id, guid: ep.guid }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error || "processing failed to start");
    }
  }
  pollStatus();
}

function updateMeta() {
  const n = state.ads.length;
  $("p-meta").textContent = state.current.showTitle +
    (n ? ` · ${n} ad${n > 1 ? "s" : ""} will be skipped` : " · ad mapping pending");
}

function pollStatus() {
  clearInterval(state.pollTimer);
  const { showId, guid } = state.current;
  state.pollTimer = setInterval(async () => {
    if (!state.current || state.current.guid !== guid) return clearInterval(state.pollTimer);
    const st = await fetch(`/api/status?show=${encodeURIComponent(showId)}&guid=${encodeURIComponent(guid)}`)
      .then((r) => r.json()).catch(() => null);
    if (!st) return;
    if (st.state === "ready") {
      clearInterval(state.pollTimer);
      state.ads = st.ads;
      if (st.durationSec) state.current.durationSec = st.durationSec;
      clearAdMarks(); paintAds(); updateMeta();
      toast(st.ads.length ? `Ad map ready — ${st.ads.length} ad${st.ads.length > 1 ? "s" : ""}` : "No ads found");
      loadShows(); // refresh chips
    } else if (st.state === "error") {
      clearInterval(state.pollTimer);
      toast("Ad mapping failed: " + (st.error || "unknown error"));
      loadShows();
    }
  }, 3000);
}

// ---- media session (lock screen / headphone controls) --------------------
function setMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.title,
    artist: state.current.showTitle,
    artwork: state.current.image ? [{ src: state.current.image, sizes: "512x512" }] : [],
  });
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("seekbackward", () => (audio.currentTime -= 15));
  ms.setActionHandler("seekforward", () => (audio.currentTime += 30));
  try { ms.setActionHandler("seekto", (e) => (audio.currentTime = e.seekTime)); } catch {}
}

// ---- controls ------------------------------------------------------------
$("btn-play").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("btn-back").addEventListener("click", () => (audio.currentTime = Math.max(0, audio.currentTime - 15)));
$("btn-fwd").addEventListener("click", () => (audio.currentTime += 30));
const RATES = [1, 1.2, 1.5, 1.8, 2];
$("btn-rate").addEventListener("click", () => {
  state.rate = RATES[(RATES.indexOf(state.rate) + 1) % RATES.length] || 1;
  audio.playbackRate = state.rate;
  localStorage.setItem("podskip.rate", String(state.rate));
  $("btn-rate").textContent = state.rate + "×";
});
$("btn-rate").textContent = state.rate + "×";
audio.addEventListener("play", paintProgress);
audio.addEventListener("pause", paintProgress);
audio.addEventListener("loadedmetadata", paintProgress);

$("seek").addEventListener("click", (e) => {
  const rect = $("seek").getBoundingClientRect();
  const dur = audio.duration || state.current?.durationSec;
  if (dur) audio.currentTime = ((e.clientX - rect.left) / rect.width) * dur;
});

// ---- boot ----------------------------------------------------------------
async function loadShows() {
  try {
    const data = await fetch("/api/shows").then((r) => r.json());
    state.shows = data.shows;
    const warn = $("keys-warning");
    if (!data.keys.transcription || !data.keys.anthropic) {
      warn.textContent = "⚠ API keys missing — playback works, ad-skipping disabled";
      warn.hidden = false;
    } else warn.hidden = true;
    render();
  } catch {
    $("main").innerHTML = `<p class="muted">Could not reach the PodSkip server.</p>`;
  }
}
loadShows();
setInterval(loadShows, 5 * 60 * 1000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
