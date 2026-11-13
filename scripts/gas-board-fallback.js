// gas-board-fallback.js
// Team fallback for the gas request board on /start (testnet only). After 6 hours
// a request leaves the public board for the team queue. Every run this reads the
// queue (action "queue", authenticated with GAS_BOARD_KEEPER_SECRET) and sends
// 0.003 test ETH on Arbitrum Sepolia from the team's gas wallet to each request,
// then submits the transaction hash to the board, which verifies it on chain
// like any community fill. Unresolved requests expire after 24 hours.
//
// Guards:
//   - at most MAX_PER_RUN fills per run (default 5) and MAX_PER_DAY team fills per
//     24 h (default 20, counted by the board);
//   - skips a request whose wallet already holds HAS_GAS_WEI (it no longer needs it);
//   - stops and alerts when the gas wallet would drop below RESERVE_WEI;
//   - stateless: the board is the record, so a re-run can't double-send (a filled
//     request leaves the open list, and the board refuses a reused hash).
//
// Env:
//   GAS_BOARD_URL            the Supabase gas-board function URL (repo variable)
//   GAS_BOARD_PROXY_SECRET   optional; sent as X-Proxy-Secret
//   GAS_BOARD_KEEPER_SECRET  required for the team queue; sent as X-Keeper-Secret
//   GAS_FALLBACK_PRIVATE_KEY the team gas wallet (repo secret; set by the owner, never pasted in chat)
//   ARB_SEPOLIA_RPC          Arbitrum Sepolia RPC
//   GAS_FALLBACK_MAX_PER_RUN optional (default 5)
//   GAS_FALLBACK_MAX_PER_DAY optional (default 20)
//   TELEGRAM_*               ops alerts (scripts/lib/telegram.js)
//
// Run:  node gas-board-fallback.js --self-test   (pure selection logic, no network)
//       node gas-board-fallback.js

"use strict";

const AMOUNT_WEI = 3_000_000_000_000_000n;   // 0.003 ETH
const HAS_GAS_WEI = 2_000_000_000_000_000n;  // already enough to play
const RESERVE_WEI = 10_000_000_000_000_000n; // keep 0.01 ETH in the gas wallet
const FALLBACK_AFTER_HOURS = 6;

// Requests due for a team fill, oldest first, capped.
function due(open, nowMs, maxPerRun) {
  const cutoff = nowMs - FALLBACK_AFTER_HOURS * 3600_000;
  return (open || [])
    .filter((r) => r && /^0x[0-9a-f]{40}$/.test(r.address) && new Date(r.created_at).getTime() <= cutoff)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(0, Math.max(0, maxPerRun));
}

function selfTest() {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const h = (n) => new Date(now - n * 3600_000).toISOString();
  const a = (c) => "0x" + c.repeat(40);
  const open = [
    { id: 1, address: a("1"), created_at: h(7) },
    { id: 2, address: a("2"), created_at: h(5.9) },   // not yet 6 h
    { id: 3, address: a("3"), created_at: h(30) },
    { id: 4, address: "0xNOTANADDRESS", created_at: h(9) },
    { id: 5, address: a("5"), created_at: h(6) },     // exactly 6 h
  ];
  const cases = [
    ["picks only requests 6 h or older, oldest first", due(open, now, 5).map((r) => r.id).join(","), "3,1,5"],
    ["respects the per-run cap", due(open, now, 2).map((r) => r.id).join(","), "3,1"],
    ["cap of 0 sends nothing", due(open, now, 0).length, 0],
    ["empty board", due([], now, 5).length, 0],
    ["null board", due(null, now, 5).length, 0],
  ];
  let fail = 0;
  for (const [name, got, want] of cases) { if (got !== want) { fail++; console.log("FAIL", name, got, "want", want); } }
  console.log(fail ? `${fail} failed` : `gas-board-fallback self-test: ${cases.length}/${cases.length} passed`);
  process.exit(fail ? 1 : 0);
}

async function board(url, secret, body, keeperSecret) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["X-Proxy-Secret"] = secret;
  if (keeperSecret) headers["X-Keeper-Secret"] = keeperSecret;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return r.json();
}

async function main() {
  const { ethers } = require("ethers");
  const { opsTelegram } = require("./lib/telegram");
  const tg = opsTelegram({ tag: "gas-board" });
  const url = process.env.GAS_BOARD_URL;
  // Secrets pasted from a phone often carry spaces, a newline or wrapping quotes
  // (straight or curly); clean them the way the board function does.
  const clean = (v) => String(v || "").trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
  const secret = clean(process.env.GAS_BOARD_PROXY_SECRET);
  const key = (process.env.GAS_FALLBACK_PRIVATE_KEY || "").trim();
  const rpcUrl = (process.env.ARB_SEPOLIA_RPC || "").trim();
  const keeperSecret = clean(process.env.GAS_BOARD_KEEPER_SECRET);
  const maxPerRun = Number(process.env.GAS_FALLBACK_MAX_PER_RUN || 5);
  const maxPerDay = Number(process.env.GAS_FALLBACK_MAX_PER_DAY || 20);
  if (!url || !key || !rpcUrl || !keeperSecret) { console.log("gas-board-fallback: GAS_BOARD_URL, GAS_BOARD_KEEPER_SECRET, GAS_FALLBACK_PRIVATE_KEY or ARB_SEPOLIA_RPC not set; nothing to do."); return; }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();
  if (net.chainId !== 421614n) throw new Error(`refusing to run on chain ${net.chainId}; the board is Arbitrum Sepolia only`);
  const wallet = new ethers.Wallet(key, provider);

  const list = await board(url, secret, { action: "queue" }, keeperSecret);
  if (!list.ok) throw new Error("board queue failed: " + (list.error || "unknown"));
  const dayLeft = Math.max(0, maxPerDay - Number(list.teamFilled24h || 0));
  const limit = Math.min(maxPerRun, dayLeft); // counts sends, not wallets skipped for already having gas
  const todo = due(list.open, Date.now(), 50);
  console.log(`gas-board-fallback: ${list.open.length} in the team queue, ${todo.length} due; sending at most ${limit} (team fills left today: ${dayLeft}).`);

  const filled = [], skipped = [], failed = [];
  for (const r of todo) {
    if (filled.length + failed.length >= limit) break;
    const bal = await provider.getBalance(r.address);
    if (bal >= HAS_GAS_WEI) { skipped.push(r.address); continue; }
    const mine = await provider.getBalance(wallet.address);
    if (mine < AMOUNT_WEI + RESERVE_WEI) {
      await tg.send(`⚠️ Gas board fallback wallet is low: ${ethers.formatEther(mine)} ETH. ${todo.length - filled.length} request(s) waiting. Top up ${wallet.address} on Arbitrum Sepolia.`);
      break;
    }
    try {
      const tx = await wallet.sendTransaction({ to: r.address, value: AMOUNT_WEI });
      await tx.wait(1);
      const res = await board(url, secret, { action: "fill", id: r.id, txHash: tx.hash });
      if (res.ok) filled.push(r.address); else failed.push(`${r.address}: ${res.error}`);
    } catch (e) { failed.push(`${r.address}: ${e.shortMessage || e.message}`); }
  }

  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  console.log(`filled ${filled.length}, skipped ${skipped.length}, failed ${failed.length}`);
  for (const f of failed) console.log("  failed:", f);
  if (filled.length || failed.length) {
    const lines = [`⛽ Gas board fallback: filled ${filled.length}` + (skipped.length ? `, skipped ${skipped.length} (already funded)` : "")];
    if (filled.length) lines.push("Sent 0.003 test ETH to " + filled.map(short).join(", "));
    if (failed.length) lines.push("⚠️ Failed: " + failed.join("; "));
    await tg.send(lines.join("\n"));
  }
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) selfTest();
  else main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { due };
