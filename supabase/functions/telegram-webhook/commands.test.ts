// node --test supabase/functions/telegram-webhook/commands.test.ts
// (Node 22.18+ strips the types itself; on older 22.x add --experimental-strip-types.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ADDR, RateLimit, TtlCache, faucetReply, fmtDuration, fmtUnits, fmtUsd, helpReply,
  parseCommand, poolLine, potReply, rankReply, roundReply, route, windowView, type RoundState,
} from "./commands.ts";

const E = 10n ** 18n;

test("bot addresses mirror config.js", () => {
  const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../config.js"), "utf8");
  for (const [name, addr] of Object.entries(ADDR)) {
    const m = new RegExp(`\\b${name}:\\s*"(0x[0-9a-fA-F]{40})"`).exec(cfg);
    assert.ok(m, `${name} missing from config.js`);
    assert.equal(addr.toLowerCase(), m![1].toLowerCase(), `${name} differs from config.js: update commands.ts ADDR`);
  }
});

test("parseCommand: known commands, bot suffix, args", () => {
  assert.deepEqual(parseCommand("/pot"), { cmd: "pot", arg: "" });
  assert.deepEqual(parseCommand("  /POT  "), { cmd: "pot", arg: "" });
  assert.deepEqual(parseCommand("/pot@TimbSwapTGBot", "TimbSwapTGBot"), { cmd: "pot", arg: "" });
  assert.equal(parseCommand("/pot@OtherBot", "TimbSwapTGBot"), null);
  assert.deepEqual(parseCommand("/rank 0xabc"), { cmd: "rank", arg: "0xabc" });
  assert.equal(parseCommand("/lottery"), null);
  assert.equal(parseCommand("gm"), null);
  assert.equal(parseCommand("what's the pot /pot"), null);
});

test("route: group silence, DM-only wallet commands, private help", () => {
  assert.deepEqual(route("gm everyone", "supergroup"), { kind: "silent" });
  assert.deepEqual(route("/unknown", "group"), { kind: "silent" });
  assert.deepEqual(route("gm", "private"), { kind: "help" });
  assert.deepEqual(route("/rank 0x1", "group"), { kind: "dm-only", cmd: "rank" });
  assert.deepEqual(route("/start 0x1", "supergroup"), { kind: "dm-only", cmd: "start" });
  assert.deepEqual(route("/stop", "group"), { kind: "dm-only", cmd: "stop" });
  assert.deepEqual(route("/rank 0x1", "private"), { kind: "command", cmd: "rank", arg: "0x1" });
  assert.deepEqual(route("/pot", "supergroup"), { kind: "command", cmd: "pot", arg: "" });
});

test("fmtUnits / fmtUsd / fmtDuration", () => {
  assert.equal(fmtUnits(46_670_000_000_000_000n, 4), "0.0466");
  assert.equal(fmtUnits(0n), "0");
  assert.equal(fmtUnits(550_000_000_000n, 8), "0.00000055");
  assert.equal(fmtUnits(5n, 8), "0.000000000000000005"); // tiny stays non-zero
  assert.equal(fmtUnits(18_252_490n * E / 1000n, 2), "18,252.49");
  assert.equal(fmtUsd(46_670_000_000_000_000n), "$140.01");
  assert.equal(fmtUsd(0n), "$0");
  assert.equal(fmtDuration(41 * 60 + 5), "41 min");
  assert.equal(fmtDuration(3 * 3600 + 120), "3h 2m");
  assert.equal(fmtDuration(87 * 86400 + 3600), "87d 1h");
  assert.equal(fmtDuration(-5), "now");
});

const state = (over: Partial<RoundState> = {}): RoundState => ({
  round: 15n, segment: 3n, segmentStart: 1_000_000n, pot: 46_670_000_000_000_000n, inSettlement: false,
  currentWindow: "K7    ", counters: [10n, 33n, 2n, 0n, 0n, 0n], locked: [true, true, false, false, false, false],
  ...over,
});

test("windowView: locked + live shown, future dotted, classes", () => {
  const s = state();
  assert.deepEqual(windowView(s.counters, s.locked, s.currentWindow, 3), { chars: "K7C···", classes: "LDL···" });
});

test("pot and round replies", () => {
  const s = state();
  const pot = potReply(s, 550_000_000_000n, 1_000_000 + 18 * 60 + 40);
  assert.match(pot, /Prize pot: 0\.0466 ETH \(≈ \$140\.01\)/);
  assert.match(pot, /Round 15 · segment 3 of 6 · next segment in 41 min/);
  assert.match(pot, /\+0\.00000055 ETH/);
  assert.match(pot, /No principal at risk/);
  assert.doesNotMatch(pot, /lottery|gambl|mining/i);
  assert.match(roundReply(state({ segment: 6n }), 1_000_000 + 60), /round settles in 58 min/);
  assert.match(roundReply(state({ inSettlement: true }), 1_000_000 + 3590), /locking now/);
  assert.match(roundReply(state({ segment: 0n }), 0), /hasn't started/);
});

test("faucet reply: open, paused, refilling", () => {
  const f = { ethPaused: false, timbsPaused: false, dripEth: 20_000_000_000_000n, potEth: 20_000_000_000_000n,
    timbsPerClaim: 100n * E, cooldown: 86400n, reserve: 205_000_000_000_000_000n, timbsBal: 249_900n * E };
  const open = faucetReply(f);
  assert.match(open, /ETH: open · 0\.00002 ETH to you \+ 0\.00002 ETH to the pot/);
  assert.match(open, /TIMBS: open · 100 TIMBS per claim/);
  assert.match(open, /One claim per 1d 0h/);
  assert.match(faucetReply({ ...f, ethPaused: true }), /ETH: paused/);
  assert.match(faucetReply({ ...f, reserve: 0n }), /ETH: refilling/);
});

test("stake lines: empty pool, staked, ended", () => {
  const rate = 2_426_736_111_111_111n; // ≈ 209.67/day
  const now = 1_000_000;
  const empty = poolLine("TIMBS staking", "TIMBS", { rate, total: 0n, finish: BigInt(now + 87 * 86400) }, now);
  assert.match(empty, /209\.66 TIMBS\/day for 87d 0h/);
  assert.match(empty, /first staker earns all/);
  assert.match(poolLine("x", "LP", { rate, total: 5n * E, finish: BigInt(now + 10) }, now), /5 LP staked/);
  assert.match(poolLine("x", "LP", { rate, total: 0n, finish: BigInt(now - 1) }, now), /no emissions running/);
});

test("rank reply", () => {
  const w = "0x66a3000000000000000000000000000000b6bf";
  assert.match(rankReply(w, null, null), /No points season/);
  assert.match(rankReply(w, "Season 1", null), /no points yet for 0x66a3…b6bf/);
  assert.match(rankReply(w, "Season 1", { rank: 3, display_tp: 1250, rounds_played: 9, wins: 1 }), /Rank #3 · 1,250 points/);
  assert.match(rankReply(w, "Season 1", { rank: 3, display_tp: 1, rounds_played: 1, wins: 0, flagged: true }), /under review/);
});

test("help hides wallet commands in groups", () => {
  assert.doesNotMatch(helpReply(true), /^\/(rank|start|stop) /m);
  assert.match(helpReply(true), /DM me/);
  assert.match(helpReply(false), /\/rank/);
});

test("cache and rate limit", () => {
  const c = new TtlCache<string>(30_000);
  c.set("pot", "a", 0);
  assert.equal(c.get("pot", 29_999), "a");
  assert.equal(c.get("pot", 30_000), undefined);
  const r = new RateLimit(10_000);
  assert.equal(r.allow("1", "pot", 0), true);
  assert.equal(r.allow("1", "pot", 9_999), false);
  assert.equal(r.allow("2", "pot", 9_999), true);
  assert.equal(r.allow("1", "pot", 10_000), true);
});
