// Run: node supabase/functions/referrals/rules.test.ts   (Node 22+, type stripping)
import { CODE_RE, bindMessage, codeFor, issuedOk, nextTier, tierOf, toBase32 } from "./rules.ts";

let fail = 0, n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) { fail++; console.log("FAIL", name, "got", got, "want", want); }
}

// tiers (horizontal ladder: D 1, C 3, B 9, A 36, S 180)
eq("0 has no tier", tierOf(0), null);
eq("1 is D", tierOf(1), "D");
eq("2 is D", tierOf(2), "D");
eq("3 is C", tierOf(3), "C");
eq("8 is C", tierOf(8), "C");
eq("9 is B", tierOf(9), "B");
eq("36 is A", tierOf(36), "A");
eq("179 is A", tierOf(179), "A");
eq("180 is S", tierOf(180), "S");
eq("past the cap stays S", tierOf(999), "S");
eq("next from 0", JSON.stringify(nextTier(0)), JSON.stringify({ tier: "D", need: 1 }));
eq("next from 2", JSON.stringify(nextTier(2)), JSON.stringify({ tier: "C", need: 1 }));
eq("next from 10", JSON.stringify(nextTier(10)), JSON.stringify({ tier: "A", need: 26 }));
eq("none past S", nextTier(180), null);

// codes
const a = "0x" + "ab".repeat(20);
const c1 = await codeFor("secret", 2, a);
eq("code shape", CODE_RE.test(c1), true);
eq("code is 7 chars", c1.length, 7);
eq("deterministic", await codeFor("secret", 2, a), c1);
eq("case-insensitive address", await codeFor("secret", 2, a.toUpperCase().replace("0X", "0x")), c1);
eq("new season, new code", (await codeFor("secret", 3, a)) !== c1, true);
eq("other secret, other code", (await codeFor("other", 2, a)) !== c1, true);
eq("8-char retry keeps prefix", (await codeFor("secret", 2, a, 8)).startsWith(c1), true);
eq("no confusable letters", /[ILOU]/.test(toBase32(new Uint8Array(64).map((_, i) => i * 37), 64)), false);

// signing
const msg = bindMessage("k7m2qx4", "0xABCDEF" + "0".repeat(34), "testnet-v2-s1", "2026-11-20T10:00:00.000Z");
eq("message", msg, "TimbSwap referral\nCode: K7M2QX4\nWallet: 0xabcdef" + "0".repeat(34) + "\nSeason: testnet-v2-s1\nIssued: 2026-11-20T10:00:00.000Z");
const now = Date.parse("2026-11-20T10:05:00Z");
eq("5 min old ok", issuedOk("2026-11-20T10:00:00Z", now), true);
eq("11 min old refused", issuedOk("2026-11-20T09:54:00Z", now), false);
eq("from the future refused", issuedOk("2026-11-20T10:07:00Z", now), false);
eq("garbage refused", issuedOk("yesterday", now), false);

console.log(fail ? `${fail} of ${n} failed` : `referral rules: all ${n} passed`);
if (fail) process.exit(1);
