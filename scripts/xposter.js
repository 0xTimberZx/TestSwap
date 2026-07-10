// xposter.js — posts settled round results to X (@timbswap) with a branded
// card image. Called by settler.js after a CONFIRMED round rollover.
//
// Opt-in and fail-safe by design:
//   - Silently no-ops unless all four X_* secrets are configured.
//   - X_POST_MODE: "all" (default) posts every rollover, "winners" posts only
//     rounds that paid out, "off" disables without removing secrets.
//   - Every failure is caught by the caller — a bad post can never break
//     settling.
//
// Auth is OAuth 1.0a user-context (posting as the app's own account), signed
// with plain node crypto — no SDK. Media goes to the v1.1 upload endpoint
// (multipart, so body params stay out of the signature), the post itself to
// the v2 /tweets endpoint (JSON body, likewise unsigned).

const crypto = require("crypto");
const path   = require("path");

const X_API_KEY             = process.env.X_API_KEY;
const X_API_SECRET          = process.env.X_API_SECRET;
const X_ACCESS_TOKEN        = process.env.X_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;
const X_POST_MODE           = (process.env.X_POST_MODE || "all").toLowerCase();

function xConfigured() {
  return !!(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_TOKEN_SECRET);
}

// ─── OAuth 1.0a ────────────────────────────────────────────────────────────────

// RFC 3986 percent-encoding (encodeURIComponent misses !'()*).
function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Authorization header for `method url`. `extraParams` must contain any
 * form-urlencoded body/query params (multipart and JSON bodies are excluded
 * from OAuth 1.0a signatures by spec, so both call sites pass none).
 */
function oauthHeader(method, url, extraParams = {}) {
  const oauth = {
    oauth_consumer_key:     X_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            X_ACCESS_TOKEN,
    oauth_version:          "1.0"
  };
  const all = { ...oauth, ...extraParams };
  const paramStr = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const key  = `${pct(X_API_SECRET)}&${pct(X_ACCESS_TOKEN_SECRET)}`;
  const sig  = crypto.createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: sig })
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(", ");
}

// ─── Round card (canvas — no browser needed on the runner) ─────────────────────

const C = {
  bg:    "#0b0f14",
  bg2:   "#0e161d",
  green: "#14f195",
  gold:  "#ffd75e",
  text:  "#e2e8f0",
  dim:   "#8ca3bf",
  faint: "#4a6278"
};

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (-90 + i * 60) * Math.PI / 180; // pointy-top
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * 1200×675 result card: round header, the six winning characters as hexagon
 * tiles (gold when the round paid out, green otherwise), stats, site URL.
 * Returns a PNG Buffer.
 */
function renderRoundCard({ round, string6, entries, potEth, winners }) {
  const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
  let font = "sans-serif";
  try {
    GlobalFonts.registerFromPath(path.join(__dirname, "assets", "SpaceGrotesk-Bold.ttf"), "SpaceGrotesk");
    font = "SpaceGrotesk";
  } catch { /* brand font missing — system font still produces a usable card */ }

  const W = 1200, H = 675;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, C.bg); bg.addColorStop(0.55, C.bg2); bg.addColorStop(1, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const won   = winners > 0;
  const tile  = won ? C.gold : C.green;

  ctx.textAlign = "center";
  ctx.fillStyle = C.faint;
  ctx.font = `28px ${font}`;
  ctx.fillText("T I M B S W A P   ·   P R I Z E   S C R O L L", W / 2, 92);

  ctx.fillStyle = C.text;
  ctx.font = `64px ${font}`;
  ctx.fillText(`ROUND #${round} SETTLED`, W / 2, 172);

  if (won) {
    ctx.fillStyle = C.gold;
    ctx.font = `34px ${font}`;
    ctx.fillText(`—  ${winners} WINNER${winners === 1 ? "" : "S"} PAID OUT  —`, W / 2, 226);
  }

  // Six hexagon tiles, centered
  const chars = (string6 || "??????").slice(0, 6).padEnd(6, "?").split("");
  const R = 62, gap = 158;
  const rowY = won ? 372 : 356;
  const startX = W / 2 - (gap * 5) / 2;
  for (let i = 0; i < 6; i++) {
    const cx = startX + i * gap;
    ctx.save();
    ctx.shadowColor = tile;
    ctx.shadowBlur  = 22;
    hexPath(ctx, cx, rowY, R);
    ctx.lineWidth   = 7;
    ctx.strokeStyle = tile;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = tile;
    ctx.font = `62px ${font}`;
    ctx.textBaseline = "middle";
    ctx.fillText(chars[i], cx, rowY + 4);
    ctx.textBaseline = "alphabetic";
  }

  ctx.fillStyle = C.dim;
  ctx.font = `32px ${font}`;
  const stats = won
    ? `${entries} entries  ·  ${potEth} ETH pot paid out`
    : `${entries} entries  ·  pot snowballs to Round #${round + 1}`;
  ctx.fillText(stats, W / 2, rowY + 148);

  ctx.fillStyle = C.green;
  ctx.font = `30px ${font}`;
  ctx.fillText("timbswap.xyz/compete", W / 2, H - 62);

  return canvas.toBuffer("image/png");
}

// ─── X API calls ───────────────────────────────────────────────────────────────

async function uploadMedia(png) {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const form = new FormData();
  form.append("media", new Blob([png], { type: "image/png" }), "round.png");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: oauthHeader("POST", url) },
    body: form
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`media upload ${res.status}: ${JSON.stringify(body)}`);
  return body.media_id_string;
}

async function tweet(text, mediaId) {
  const url = "https://api.twitter.com/2/tweets";
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader("POST", url),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`tweet ${res.status}: ${JSON.stringify(body)}`);
  return body?.data?.id;
}

// ─── Entry point ───────────────────────────────────────────────────────────────

/**
 * Post a settled round to X. `result` = { round, string6, entries, potEth,
 * winners } with plain JS numbers/strings. Throws on failure — the settler
 * wraps this in try/catch so posting can never affect settlement.
 */
async function postRoundToX(result) {
  if (!xConfigured()) { console.log("[xposter] No X credentials — skipping."); return null; }
  if (X_POST_MODE === "off") { console.log("[xposter] X_POST_MODE=off — skipping."); return null; }
  if (X_POST_MODE === "winners" && result.winners === 0) {
    console.log("[xposter] No winners this round and X_POST_MODE=winners — skipping.");
    return null;
  }

  const won = result.winners > 0;
  const text = won
    ? `🏆 Round #${result.round} SETTLED — we have ${result.winners === 1 ? "a winner" : result.winners + " winners"}!\n\n` +
      `Winning string: ${result.string6}\n${result.entries} entries · ${result.potEth} ETH paid out\n\n` +
      `A new round is already live → timbswap.xyz/compete`
    : `📜 Round #${result.round} settled\n\n` +
      `Winning string: ${result.string6} · ${result.entries} entries · pot snowballs\n\n` +
      `Enter the next round → timbswap.xyz/compete`;

  let mediaId = null;
  try {
    mediaId = await uploadMedia(renderRoundCard(result));
  } catch (e) {
    // Card is decoration — post text-only rather than not at all.
    console.warn("[xposter] card/media failed, posting text-only:", e?.message || e);
  }
  const id = await tweet(text, mediaId);
  console.log(`[xposter] Posted round #${result.round} → tweet ${id}`);
  return id;
}

module.exports = { postRoundToX, renderRoundCard };
