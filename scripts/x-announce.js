// x-announce.js — one-off announcement post to X (@TimbSwap) with a card in
// the round-card style: a kicker, a title, a six-letter word in hexagon tiles,
// a subtitle and a URL. Run by .github/workflows/admin-x-announce.yml.
//
// Env:
//   ANNOUNCE_TEXT     the post text (required; must fit 280 characters)
//   ANNOUNCE_WORD     six letters for the hexagons (default FAUCET)
//   ANNOUNCE_KICKER   small line on top (default "TimbSwap · Testnet v2")
//   ANNOUNCE_TITLE    big line (default "New prize game live")
//   ANNOUNCE_SUB      line under the hexagons
//   ANNOUNCE_URL      green footer (default timbswap.xyz/faucet)
//   ANNOUNCE_DRY_RUN  "1" renders the card to announce-card.png and prints the
//                     text; posts nothing
//   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
//
// Length is counted the way X weighs it: most Latin text counts 1, emoji and
// CJK count 2. URLs are counted at their plain length, which for these short
// links is never more than X's fixed 23, so a post that passes here fits.

"use strict";

const fs = require("fs");
const { renderAnnounceCard, tweet, uploadMedia, xConfigured } = require("./xposter");

// X's weighting (twitter-text v3): these code-point ranges count 1, all else 2.
function xLength(text) {
  const one = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0xFE0F) continue; // emoji variation selector rides on the emoji
    n += one.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

function plan(env = process.env) {
  const text = (env.ANNOUNCE_TEXT || "").replace(/\\n/g, "\n").trim();
  const word = (env.ANNOUNCE_WORD || "FAUCET").trim().toUpperCase();
  const card = {
    kicker: env.ANNOUNCE_KICKER || "TimbSwap · Testnet v2",
    title:  env.ANNOUNCE_TITLE  || "New prize game live",
    word,
    sub:    env.ANNOUNCE_SUB    || "Fresh contracts · pools refilled · Season 1 scoring on",
    url:    env.ANNOUNCE_URL    || "timbswap.xyz/faucet"
  };
  const errors = [];
  if (!text) errors.push("ANNOUNCE_TEXT is empty");
  if (xLength(text) > 280) errors.push(`text weighs ${xLength(text)} of X's 280 characters`);
  if (!/^[A-Z0-9]{6}$/.test(word)) errors.push(`ANNOUNCE_WORD must be exactly 6 letters or digits, got "${word}"`);
  return { text, card, errors };
}

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL", m); } };
  ok(plan({ ANNOUNCE_TEXT: "hi" }).errors.length === 0, "defaults are valid");
  ok(plan({ ANNOUNCE_TEXT: "hi" }).card.word === "FAUCET", "default word");
  ok(plan({ ANNOUNCE_TEXT: "" }).errors.length === 1, "empty text refused");
  ok(plan({ ANNOUNCE_TEXT: "x".repeat(281) }).errors.length === 1, "long text refused");
  ok(plan({ ANNOUNCE_TEXT: "hi", ANNOUNCE_WORD: "GAS" }).errors.length === 1, "short word refused");
  ok(xLength("ab") === 2 && xLength("🚀") === 2 && xLength("→") === 2 && xLength("·") === 1, "X weighting");
  ok(plan({ ANNOUNCE_TEXT: "🚀".repeat(141) }).errors.length === 1, "emoji counted double");
  ok(plan({ ANNOUNCE_TEXT: "a\\nb" }).text === "a\nb", "\\n becomes a newline");
  const png = renderAnnounceCard(plan({ ANNOUNCE_TEXT: "hi" }).card);
  ok(png.length > 1000 && png[0] === 0x89, "card renders a PNG");
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const { text, card, errors } = plan();
  if (errors.length) { errors.forEach((e) => console.error(`::error::${e}`)); process.exit(1); }

  console.log(`--- post (${xLength(text)}/280) ---\n${text}\n--- card ---\n${JSON.stringify(card, null, 2)}`);
  const png = renderAnnounceCard(card);
  fs.writeFileSync("announce-card.png", png);

  if (process.env.ANNOUNCE_DRY_RUN === "1") { console.log("DRY RUN — card saved, nothing posted."); return; }
  if (!xConfigured()) { console.error("::error::X credentials are not set"); process.exit(1); }
  const mediaId = await uploadMedia(png);
  const id = await tweet(text, mediaId);
  console.log(`Posted → https://x.com/TimbSwap/status/${id}`);
}

main().catch((e) => { console.error(`::error::${e.message || e}`); process.exit(1); });
