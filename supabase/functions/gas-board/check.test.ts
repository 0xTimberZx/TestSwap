// Run: node supabase/functions/gas-board/check.test.ts   (Node 22+, type stripping)
import { ADDR_RE, HASH_RE, checkFill } from "./check.ts";

const req = { address: "0x" + "ab".repeat(20), created_at: "2026-11-20T10:00:00Z", status: "open" };
const created = Math.floor(new Date(req.created_at).getTime() / 1000);
const good = { to: "0x" + "AB".repeat(20), from: "0x" + "cd".repeat(20), value: "0xaa87bee538000", blockNumber: "0x10" }; // 0.003 ETH
const SEP = "0x66eee";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) { fail++; console.log("FAIL", name, "got", got, "want", want); }
}

eq("good fill passes", checkFill(req, good, "0x1", created + 30, SEP), null);
eq("more than 0.003 passes", checkFill(req, { ...good, value: "0x2386f26fc10000" }, "0x1", created + 30, SEP), null);
eq("closed request", checkFill({ ...req, status: "filled" }, good, "0x1", created + 30, SEP), "This request is no longer open.");
eq("wrong chain", checkFill(req, good, "0x1", created + 30, "0xa4b1"), "The board only accepts Arbitrum Sepolia transactions.");
eq("pending tx", checkFill(req, { ...good, blockNumber: null }, null, null, SEP), "That transaction isn't confirmed yet. Try again in a minute.");
eq("reverted tx", checkFill(req, good, "0x0", created + 30, SEP), "That transaction failed on chain.");
eq("wrong recipient", checkFill(req, { ...good, to: "0x" + "ef".repeat(20) }, "0x1", created + 30, SEP), "That transaction wasn't sent to this address.");
eq("contract creation (no to)", checkFill(req, { ...good, to: null }, "0x1", created + 30, SEP), "That transaction wasn't sent to this address.");
eq("too little", checkFill(req, { ...good, value: "0x5af3107a4000" }, "0x1", created + 30, SEP), "That transaction sent less than 0.003 ETH."); // 0.0001
eq("older than request", checkFill(req, good, "0x1", created - 3600, SEP), "That transaction is older than the request.");
eq("within 60 s clock slack", checkFill(req, good, "0x1", created - 30, SEP), null);
eq("address regex ok", ADDR_RE.test("0x" + "a1".repeat(20)), true);
eq("address regex short", ADDR_RE.test("0x1234"), false);
eq("hash regex ok", HASH_RE.test("0x" + "f".repeat(64)), true);
eq("hash regex bad", HASH_RE.test("0x" + "f".repeat(63)), false);

console.log(fail ? `${fail} failed` : "gas-board check: all 15 passed");
if (fail) process.exit(1);
