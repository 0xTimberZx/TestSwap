// bounty-payouts.js — list the bounty wallet's payouts with their tx hashes.
//
// The bounty page promises that every payout is published with its transaction
// hash. The payouts go out from a plain wallet whose send history shows the
// recipients but not the hashes, so this reads them back from the chain: every
// token Transfer FROM the bounty wallet in a time window, with block, time,
// recipient, amount and the Arbiscan link. Read-only, no key.
//
// Output: a markdown table on stdout (and in the Actions job summary when
// GITHUB_STEP_SUMMARY is set), and a CSV for the ledger. With --expect FILE (a
// CSV with `receiver` and `amount` columns, such as a Safe CSV Airdrop file) it
// also reconciles: each expected recipient's paid total against its amount.
//
// Env:
//   PAYOUT_RPC       Arbitrum One RPC (default the public endpoint; a keyed URL
//                    belongs in a secret and is scrubbed from every error)
//   BOUNTY_WALLET    the paying wallet (default the published bounty wallet)
//   PAYOUT_TOKEN     the token paid (default canonical USDT on Arbitrum One)
//   PAYOUT_SINCE     ISO time the window starts (default 2026-10-30T00:00:00Z)
//   PAYOUT_UNTIL     ISO time it ends (default now)
//   PAYOUT_CHAIN_ID  chain the RPC must be on (default 42161)
//   PAYOUT_OUT       CSV path (default bounty-payouts.csv)
//
// Flags: --self-test (no network)  --expect FILE

"use strict";

const fs = require("fs");
const { ethers, scanLogs, blockTimestamps } = require("./lib/logs");

const DEFAULTS = {
  rpc: "https://arb1.arbitrum.io/rpc",
  wallet: "0x6dc9380d32Bd7CaA16Cc079073fb54D644C6138C",
  token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  since: "2026-10-30T00:00:00Z",
  chainId: 42161,
  out: "bounty-payouts.csv",
};
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ARBISCAN_TX = "https://arbiscan.io/tx/";

// ─── Pure logic (exported for --self-test) ──────────────────────────────────

/** Mask the configured RPC URL and any /vN/<key> path in text bound for a log. */
function redact(text, url = process.env.PAYOUT_RPC) {
  let s = String(text);
  if (url) s = s.split(url).join("<PAYOUT_RPC>");
  return s.replace(/(\/v[0-9]\/)[A-Za-z0-9_-]{8,}/g, "$1<key>");
}

/**
 * Smallest block in [lo, hi] whose timestamp is >= target, given an async
 * tsOf(block). Returns hi + 1 when every block is earlier.
 */
async function firstBlockAtOrAfter(tsOf, lo, hi, target) {
  let a = lo, b = hi + 1;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if ((await tsOf(mid)) >= target) b = mid; else a = mid + 1;
  }
  return a;
}

/** A Transfer log as a payout row (topics[2] is the recipient). */
function decodeTransfer(log, decimals) {
  const to = ethers.getAddress("0x" + log.topics[2].slice(26));
  const raw = BigInt(log.data);
  return { block: log.blockNumber, tx: log.transactionHash, to, raw, amount: ethers.formatUnits(raw, decimals) };
}

/** Parse a CSV with `receiver` and `amount` columns: [{ to, raw }]. */
function parseExpect(text, decimals) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(",").map((h) => h.trim());
  const iTo = head.indexOf("receiver"), iAmt = head.indexOf("amount");
  if (iTo < 0 || iAmt < 0) throw new Error("expect file needs `receiver` and `amount` columns");
  return lines.filter((l) => l.trim()).map((l) => {
    const c = l.split(",");
    return { to: ethers.getAddress(c[iTo].trim().toLowerCase()), raw: ethers.parseUnits(c[iAmt].trim(), decimals) };
  });
}

/**
 * Reconcile expected payouts against what was paid. One row per address that
 * was expected or paid: status ok | short | over | missing | unexpected.
 */
function reconcile(expected, paid) {
  const key = (a) => a.toLowerCase();
  const want = new Map(), got = new Map(), txs = new Map();
  for (const e of expected) want.set(key(e.to), (want.get(key(e.to)) || 0n) + e.raw);
  for (const p of paid) {
    got.set(key(p.to), (got.get(key(p.to)) || 0n) + p.raw);
    txs.set(key(p.to), (txs.get(key(p.to)) || []).concat(p.tx));
  }
  const rows = [];
  for (const a of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(a), g = got.get(a) || 0n;
    const status = w === undefined ? "unexpected" : g === 0n ? "missing" : g === w ? "ok" : g < w ? "short" : "over";
    rows.push({ to: ethers.getAddress(a), want: w ?? 0n, got: g, status, txs: txs.get(a) || [] });
  }
  return rows;
}

const iso = (ts) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

module.exports = { redact, firstBlockAtOrAfter, decodeTransfer, parseExpect, reconcile };

// ─── Self-test ──────────────────────────────────────────────────────────────

async function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL", name); } };

  // A fake chain: block n has timestamp 1000 + 4n (0.25 s blocks, coarse).
  const ts = async (n) => 1000 + 4 * n;
  t("first block at a time", (await firstBlockAtOrAfter(ts, 0, 100, 1040)) === 10);
  t("between blocks rounds up", (await firstBlockAtOrAfter(ts, 0, 100, 1041)) === 11);
  t("before the range is lo", (await firstBlockAtOrAfter(ts, 5, 100, 0)) === 5);
  t("after the range is hi + 1", (await firstBlockAtOrAfter(ts, 0, 100, 99999)) === 101);

  const to = "0x9C4DBa59965A3689C22627348AdD60b29De164A9";
  const log = { blockNumber: 7, transactionHash: "0x" + "ab".repeat(32),
    topics: [TRANSFER, ethers.zeroPadValue(DEFAULTS.wallet, 32), ethers.zeroPadValue(to, 32)],
    data: ethers.toBeHex(158330000n, 32) };
  const d = decodeTransfer(log, 6);
  t("decodes the recipient checksummed", d.to === to);
  t("decodes the amount at 6 decimals", d.amount === "158.33" && d.raw === 158330000n);

  const exp = parseExpect("token_type,token_address,receiver,amount,id\nerc20,0x0,0x9c4dba59965a3689c22627348add60b29de164a9,158.33,\nerc20,0x0,0x43617ef72a6e416719293def2a654b4f35a51a52,157.98,\nerc20,0x0,0x121189da04911de3e435d647ec9d4013e557b719,5.26,\n", 6);
  t("parses a Safe CSV", exp.length === 3 && exp[0].raw === 158330000n);
  const paid = [
    { to, raw: 1000000n, tx: "0x1" }, { to, raw: 157330000n, tx: "0x2" },                        // test + remainder
    { to: "0x43617ef72A6E416719293DeF2A654b4F35A51a52", raw: 150000000n, tx: "0x3" },              // short
    { to: "0x0000000000000000000000000000000000000001", raw: 5n, tx: "0x4" },                      // unexpected
  ];
  const r = Object.fromEntries(reconcile(exp, paid).map((x) => [x.to.slice(0, 8).toLowerCase(), x]));
  t("test transfer + remainder adds up to ok", r["0x9c4dba"].status === "ok" && r["0x9c4dba"].txs.length === 2);
  t("an underpayment is short", r["0x43617e"].status === "short");
  t("an unpaid recipient is missing", r["0x121189"].status === "missing");
  t("a payment nobody expected is flagged", r["0x000000"].status === "unexpected");
  t("an overpayment is over", reconcile([{ to, raw: 1110000n }], [{ to, raw: 1111500n, tx: "0x5" }])[0].status === "over");

  t("redact masks the configured URL", !redact("fail https://arb.example/v2/KEYKEYKEY1 x", "https://arb.example/v2/KEYKEYKEY1").includes("KEYKEYKEY1"));
  t("redact masks a key path without the URL set", !redact("GET https://x.io/v2/abcdEFGH1234 failed", "").includes("abcdEFGH1234"));

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ─── Live run ───────────────────────────────────────────────────────────────

async function main() {
  const env = process.env;
  const rpc = env.PAYOUT_RPC || DEFAULTS.rpc;
  const wallet = ethers.getAddress(env.BOUNTY_WALLET || DEFAULTS.wallet);
  const token = ethers.getAddress(env.PAYOUT_TOKEN || DEFAULTS.token);
  const since = Math.floor(Date.parse(env.PAYOUT_SINCE || DEFAULTS.since) / 1000);
  const until = env.PAYOUT_UNTIL ? Math.floor(Date.parse(env.PAYOUT_UNTIL) / 1000) : null;
  const wantChain = Number(env.PAYOUT_CHAIN_ID || DEFAULTS.chainId);
  const outPath = env.PAYOUT_OUT || DEFAULTS.out;
  const ei = process.argv.indexOf("--expect");
  const expectPath = ei > 0 ? process.argv[ei + 1] : null;
  if (!Number.isFinite(since) || (until !== null && !Number.isFinite(until))) throw new Error("PAYOUT_SINCE / PAYOUT_UNTIL must be ISO times");

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== wantChain) throw new Error(`RPC is on chain ${chainId}, expected ${wantChain}`);
  const erc = new ethers.Contract(token, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
  const [decimals, symbol] = await Promise.all([erc.decimals().then(Number), erc.symbol()]);

  const head = await provider.getBlockNumber();
  const tsOf = async (n) => (await provider.getBlock(n)).timestamp;
  const fromBlock = await firstBlockAtOrAfter(tsOf, 0, head, since);
  const toBlock = until === null ? head : (await firstBlockAtOrAfter(tsOf, fromBlock, head, until + 1)) - 1;
  console.log(`bounty payouts: ${symbol} from ${wallet} on chain ${chainId}, blocks ${fromBlock}-${toBlock} (${iso(since)} to ${until === null ? "now" : iso(until)})`);

  const logs = await scanLogs(provider, {
    address: token, topics: [TRANSFER, ethers.zeroPadValue(wallet, 32)],
    fromBlock, toBlock, chunk: Number(env.PAYOUT_CHUNK || 40_000),
  });
  const paid = logs.map((l) => decodeTransfer(l, decimals));
  const times = await blockTimestamps(provider, paid.map((p) => p.block));
  const total = paid.reduce((s, p) => s + p.raw, 0n);

  const md = [`### Bounty payouts (${symbol}, ${paid.length} transfers, ${ethers.formatUnits(total, decimals)} total)`, "",
    "| # | Time (UTC) | To | Amount | Tx |", "|---:|---|---|---:|---|",
    ...paid.map((p, i) => `| ${i + 1} | ${iso(times[p.block])} | \`${p.to}\` | ${p.amount} | [${short(p.tx)}](${ARBISCAN_TX}${p.tx}) |`)];

  if (expectPath) {
    const rows = reconcile(parseExpect(fs.readFileSync(expectPath, "utf8"), decimals), paid);
    const bad = rows.filter((r) => r.status !== "ok");
    md.push("", `### Reconciliation against ${expectPath}: ${rows.length - bad.length} ok, ${bad.length} to look at`, "");
    if (bad.length) {
      md.push("| To | Expected | Paid | Status |", "|---|---:|---:|---|",
        ...bad.map((r) => `| \`${r.to}\` | ${ethers.formatUnits(r.want, decimals)} | ${ethers.formatUnits(r.got, decimals)} | ${r.status} |`));
    }
  }

  const text = md.join("\n") + "\n";
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  fs.writeFileSync(outPath, "time_utc,block,tx_hash,to,amount,arbiscan\n" +
    paid.map((p) => `${iso(times[p.block])},${p.block},${p.tx},${p.to},${p.amount},${ARBISCAN_TX}${p.tx}`).join("\n") + "\n");
  console.log(`wrote ${outPath}`);
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) selfTest();
  else main().catch((e) => { console.error("bounty-payouts failed:", redact(e.message || e)); process.exit(1); });
}
