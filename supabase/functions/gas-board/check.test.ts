// Run: node supabase/functions/gas-board/check.test.ts   (Node 22+, type stripping)
import { ADDR_RE, HASH_RE, MAX_OPEN, checkFill, checkRequest, isPublic } from "./check.ts";

const req = { address: "0x" + "ab".repeat(20), created_at: "2026-11-20T10:00:00Z", status: "open" };
const created = Math.floor(new Date(req.created_at).getTime() / 1000);
const good = { to: "0x" + "AB".repeat(20), from: "0x" + "cd".repeat(20), value: "0xaa87bee538000", blockNumber: "0x10" }; // 0.003 ETH
const SEP = "0x66eee";

let fail = 0, n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) { fail++; console.log("FAIL", name, "got", got, "want", want); }
}

// ── fills ──
eq("good fill passes", checkFill(req, good, "0x1", created + 30, SEP), null);
eq("more than 0.003 passes", checkFill(req, { ...good, value: "0x2386f26fc10000" }, "0x1", created + 30, SEP), null);
eq("exactly 0.001 passes (a third of the ask)", checkFill(req, { ...good, value: "0x38d7ea4c68000" }, "0x1", created + 30, SEP), null);
eq("just under 0.001 refused", checkFill(req, { ...good, value: "0x38d7ea4c67fff" }, "0x1", created + 30, SEP), "That transaction sent less than 0.001 ETH.");
eq("closed request", checkFill({ ...req, status: "filled" }, good, "0x1", created + 30, SEP), "This request is no longer open.");
eq("wrong chain", checkFill(req, good, "0x1", created + 30, "0xa4b1"), "The board only accepts Arbitrum Sepolia transactions.");
eq("pending tx", checkFill(req, { ...good, blockNumber: null }, null, null, SEP), "That transaction isn't confirmed yet. Try again in a minute.");
eq("reverted tx", checkFill(req, good, "0x0", created + 30, SEP), "That transaction failed on chain.");
eq("wrong recipient", checkFill(req, { ...good, to: "0x" + "ef".repeat(20) }, "0x1", created + 30, SEP), "That transaction wasn't sent to this address.");
eq("contract creation (no to)", checkFill(req, { ...good, to: null }, "0x1", created + 30, SEP), "That transaction wasn't sent to this address.");
eq("older than request", checkFill(req, good, "0x1", created - 3600, SEP), "That transaction is older than the request.");
eq("within 60 s clock slack", checkFill(req, good, "0x1", created - 30, SEP), null);

// ── posting guards ──
const now = Date.UTC(2026, 10, 20, 12, 0, 0);
const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
eq("fresh address may post", checkRequest([], now, 0), null);
eq("posted 23 h ago: cooldown", checkRequest([{ status: "expired", created_at: ago(23), filled_at: null }], now, 0),
  "One request per address every 24 hours, counted from the last post or resolution.");
eq("posted 25 h ago, never filled: may post", checkRequest([{ status: "expired", created_at: ago(25), filled_at: null }], now, 0), null);
eq("posted 30 h ago but resolved 2 h ago: cooldown", checkRequest([{ status: "filled", created_at: ago(30), filled_at: ago(2) }], now, 0),
  "One request per address every 24 hours, counted from the last post or resolution.");
eq("resolved 25 h ago: may post", checkRequest([{ status: "filled", created_at: ago(30), filled_at: ago(25) }], now, 0), null);
const thrice = [1, 2, 3].map((d) => ({ status: "filled", created_at: ago(100 * d), filled_at: ago(100 * d - 1) }));
eq("helped 3 times: refused for good", checkRequest(thrice, now, 0), "This address has already been helped 3 times.");
eq("board full", checkRequest([], now, MAX_OPEN), "The board is full right now. Try again in a few hours.");
eq("board one short of full", checkRequest([], now, MAX_OPEN - 1), null);

// ── public window ──
eq("5 h 59 m old is public", isPublic(ago(5.98), now), true);
eq("6 h old leaves the board", isPublic(ago(6), now), false);

// ── formats ──
eq("address regex ok", ADDR_RE.test("0x" + "a1".repeat(20)), true);
eq("address regex short", ADDR_RE.test("0x1234"), false);
eq("hash regex ok", HASH_RE.test("0x" + "f".repeat(64)), true);
eq("hash regex bad", HASH_RE.test("0x" + "f".repeat(63)), false);

console.log(fail ? `${fail} of ${n} failed` : `gas-board check: all ${n} passed`);
if (fail) process.exit(1);
