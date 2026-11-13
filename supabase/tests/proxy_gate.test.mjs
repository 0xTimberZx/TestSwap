// Proxy-secret gate + special-character checks.
// Run: node supabase/tests/proxy_gate.test.mjs   (Node 22+)
//
// 1. Every edge function carries an identical copy of the proxy-gate block.
// 2. A secret pasted into Cloudflare and Supabase, in any of the awkward forms a
//    phone produces (spaces, newline, straight or curly quotes, symbols), passes
//    end to end through the Worker's cleaning and real fetch Headers; a secret a
//    header can't carry fails closed on both sides with a clear status.
// 3. Input checks hold against special characters (markup, quotes, control
//    characters, emoji, right-to-left marks, SQL-looking text).
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let fail = 0, n = 0;
function eq(name, got, want) { n++; if (got !== want) { fail++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); } }

// ── 1. identical gate in every function ──
const FNS = ["waitlist", "faucet-claim", "presence", "gas-board", "referrals"];
const blocks = FNS.map((f) => {
  const m = /\/\/ proxy-gate:start[\s\S]*?\/\/ proxy-gate:end/.exec(read(`supabase/functions/${f}/index.ts`));
  if (!m) throw new Error(`no proxy-gate block in ${f}`);
  return m[0];
});
for (let i = 1; i < blocks.length; i++) eq(`gate in ${FNS[i]} identical to ${FNS[0]}`, blocks[i], blocks[0]);

const env = {};
globalThis.Deno = { env: { get: (k) => env[k] } };
const { proxyGate } = new Function(stripTypeScriptTypes(blocks[0]) + "\nreturn { proxyGate };")();
const workerSrc = read("workers/timbswap-api.js");
const ps = /function proxySecret\(name, value\) \{[\s\S]*?\n\}/.exec(workerSrc)[0];
const proxySecret = new Function("console", ps + "\nreturn proxySecret;")({ error() {} });

// One request through the Worker to a function: both sides pasted (maybe differently).
function roundTrip(cloudflare, supabase, override) {
  env.T_SECRET = supabase;
  const gate = proxyGate("T_SECRET");
  const w = proxySecret("T_SECRET", cloudflare);
  if (!w.ok) return "worker-500";
  let sent = null;
  if (override !== undefined) sent = override;
  else if (w.value) sent = new Headers({ "X-Proxy-Secret": w.value }).get("X-Proxy-Secret");   // real fetch rules
  return gate(sent);
}
const HEX = "9f".repeat(32);
eq("hex", roundTrip(HEX, HEX), "ok");
eq("symbols", roundTrip("Ab1!@#$%^&*()_+-=[]{}|;:,.<>?/~`", "Ab1!@#$%^&*()_+-=[]{}|;:,.<>?/~`"), "ok");
eq("trailing spaces (Cloudflare)", roundTrip(HEX + "   ", HEX), "ok");
eq("trailing newline (Supabase)", roundTrip(HEX, HEX + "\n"), "ok");
eq("wrapped in straight quotes", roundTrip(`"${HEX}"`, HEX), "ok");
eq("wrapped in curly quotes", roundTrip(`“${HEX}”`, `'${HEX}'`), "ok");
eq("both pasted with junk", roundTrip(` ‘${HEX}’ \n`, `"${HEX}"\n`), "ok");
eq("different secrets", roundTrip(HEX, "8e".repeat(32)), "forbidden");
eq("emoji inside: Worker refuses", roundTrip("abc\u{1F511}123", "abc\u{1F511}123"), "worker-500");
eq("emoji inside: function fails closed", (env.T_SECRET = "abc\u{1F511}123", proxyGate("T_SECRET")("abc123")), "misconfigured");
eq("accent inside: Worker refuses", roundTrip("abcé123", "abcé123"), "worker-500");
eq("space inside: Worker refuses", roundTrip("abc 123", "abc 123"), "worker-500");
eq("only quotes set: fails closed", (env.T_SECRET = '""', proxyGate("T_SECRET")(null)), "misconfigured");
eq("unset: gate off", (env.T_SECRET = undefined, proxyGate("T_SECRET")(null)), "ok");
eq("set, header missing", roundTrip("", HEX), "forbidden");
eq("set, attacker header", roundTrip(HEX, HEX, "guess"), "forbidden");
eq("set, attacker sends secret plus junk", roundTrip(HEX, HEX, HEX + "x"), "forbidden");

// ── 3. input checks ──
const waitlist = read("supabase/functions/waitlist/index.ts");
const EMAIL_RE = new Function("return " + /const EMAIL_RE\s*=\s*(\/.*\/);/.exec(waitlist)[1])();
const TG_RE = new Function("return " + /const TG_RE\s*=\s*(\/.*\/);/.exec(waitlist)[1])();
const okEmail = ["a@b.co", "o'brien@example.com", "first.last+tag@sub.example.io", "名前@例え.jp"];
const badEmail = ["<script>@x.com", "a@b", "a b@c.com", "a@b.com\n", "\"q\"@x.com", "a@b.com;rm", "a@(b).com", "a\u0000@b.com", "a@b.c'om", "x\\y@z.com"];
for (const e of okEmail) eq(`email ok ${JSON.stringify(e)}`, EMAIL_RE.test(e), true);
for (const e of badEmail) eq(`email refused ${JSON.stringify(e)}`, EMAIL_RE.test(e), false);
for (const t of ["timber_zx", "Timbswap2026"]) eq(`telegram ok ${t}`, TG_RE.test(t), true);
for (const t of ["abc", "<b>name</b>", "name with space", "‮evil", "x".repeat(33), "naïve", "' OR 1=1--"]) eq(`telegram dropped ${JSON.stringify(t)}`, TG_RE.test(t), false);

const { ADDR_RE, HASH_RE } = await import(path.join(ROOT, "supabase/functions/gas-board/check.ts"));
const { CODE_RE } = await import(path.join(ROOT, "supabase/functions/referrals/rules.ts"));
const addr = "0x" + "ab".repeat(20);
for (const bad of [addr + "\n", " " + addr, addr.slice(0, 41) + "а", "<img src=x>", "0x" + "'".repeat(40), addr + "'; drop table gas_requests;--"])
  eq(`address refused ${JSON.stringify(bad).slice(0, 30)}`, ADDR_RE.test(bad), false);
eq("hash with newline refused", HASH_RE.test("0x" + "a".repeat(64) + "\n"), false);
for (const bad of ["K7M2QXİ", "K7M2QX4<", "K7M 2QX", "K7M2QXI", "‮K7M2QX4", "' OR 1--"]) eq(`code refused ${JSON.stringify(bad)}`, CODE_RE.test(bad), false);

// ?r capture in config.js (regex + alphabet check)
const cfg = read("config.js");
const capture = new Function("return " + /var m = (\/\[\?&\]r=.*?\/)\.exec/.exec(cfg)[1])();
const alpha = /^[0-9A-HJKMNP-TV-Z]{7,8}$/;
const captured = (q) => { const m = capture.exec(q); return !!m && alpha.test(m[1].toUpperCase()); };
eq("capture plain", captured("?r=k7m2qx4"), true);
eq("capture among params", captured("?utm=x&r=K7M2QX4&y=1"), true);
for (const q of ["?r=%3Cscript%3E", "?r=K7M2QX4%22", "?r=K7M2QXI", "?r=K7M2QX4extra", "?r=", "?rr=K7M2QX4"]) eq(`capture refused ${q}`, captured(q), false);

// escaping used before innerHTML in referral.js
const refJs = read("assets/referral.js");
const esc = new Function("return " + /function esc\(v\) \{ (return [\s\S]*?) \}\n/.exec(refJs)[1].replace(/^return /, "function (v) { return ") + " }")();
eq("esc markup", esc('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
eq("esc quotes and ampersand", esc(`Tom & "Jerry" 'x'`), "Tom &amp; &quot;Jerry&quot; &#39;x&#39;");

console.log(fail ? `${fail} of ${n} failed` : `proxy gate + special characters: all ${n} passed`);
if (fail) process.exit(1);
