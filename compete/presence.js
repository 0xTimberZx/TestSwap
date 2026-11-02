// presence.js — the live watcher count (flat eye icon + number) on /compete.
//
// Counts every open tab, connected or not: each tab makes a random id, and
// while the page is visible it heartbeats POST /api/presence every 15 s. The
// server counts a tab while its last heartbeat is under 30 s old. Hiding or
// closing the tab sends a leave, so the count drops at once; a tab that just
// disappears (crash, lost signal) ages out after 30 s.
//
// Nothing about the visitor is sent except that random id. If the endpoint is
// missing or failing, the badge stays hidden and nothing else on the page is
// affected. The eye only shows when 2 or more people are watching.

(function () {
  "use strict";

  const ENDPOINT = "/api/presence";
  const PAGE     = "compete";
  const BEAT_MS  = 15000;

  const badge = document.getElementById("sub-watch");
  const num   = document.getElementById("sub-watch-n");
  const sep   = document.getElementById("watch-sep");
  if (!badge || !num || !window.fetch) return;

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // One id per tab, kept across reloads of that tab so a refresh isn't a
  // second watcher.
  let sid;
  try { sid = sessionStorage.getItem("timbswap_presence_sid"); } catch (e) { /* private mode */ }
  if (!sid) {
    sid = newId();
    try { sessionStorage.setItem("timbswap_presence_sid", sid); } catch (e) { /* fine */ }
  }

  let timer = null;
  let failures = 0;

  function show(n) {
    num.textContent = String(n);
    badge.hidden = false;
    if (sep) sep.hidden = false;
  }
  function hide() {
    badge.hidden = true;
    if (sep) sep.hidden = true;
  }

  async function beat() {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid, page: PAGE }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      failures = 0;
      // Only worth showing when someone else is here too: alone, the eye hides.
      const n = Number(data.watching) || 0;
      if (n >= 2) show(n); else hide();
    } catch (e) {
      // Give up quietly after a few misses; try again when the tab is next shown.
      if (++failures >= 3) { hide(); stop(); }
    }
  }

  function leave() {
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid, page: PAGE, leave: true }),
        keepalive: true,
      });
    } catch (e) { /* the row ages out anyway */ }
  }

  function start() {
    if (timer) return;
    failures = 0;
    beat();
    timer = setInterval(beat, BEAT_MS);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") start();
    else { stop(); leave(); }
  });
  window.addEventListener("pagehide", () => { stop(); leave(); });

  if (document.visibilityState === "visible") start();
})();
