// wind-down-owner.js — the old testnet's owner-only wind-down, signed by its owner.
//
// The 22 Oct rotation made one wallet the owner of every old contract (its key
// is the NEW_OWNER_PRIVATE_KEY secret). Before the redeploy that wallet:
//
//   pause     stops new entries on the old prize (TimbPrize.pauseEntries) and
//             both legs of the old faucet (GasFaucet.setEthPaused / setTimbsPaused).
//             Exits stay open: claims, refunds, LP, farm and lock withdrawals.
//   retire    TimbPrize.retire() and GameRegistry.retireGame(). Only once the
//             last round has settled: refused unless the prize is on segment 1
//             of a round (override with WIND_DOWN_FORCE_RETIRE=1).
//   cut       TimbPrize.withdrawProtocolCut(to): the accrued protocol cut.
//   vault     TimbYieldVault.emergencyWithdraw(to, reserve()): the free reserve
//             only. The vault itself refuses anything owed to the pot.
//   treasury  every non-zero balance the old treasury holds of ETH (withdraw-
//             Operational), WETH, USDC, USDT, LINK, DAPP and every pool's LP
//             token (withdrawToken). Old TIMBS is left behind: it does not
//             carry over.
//
// Everything goes to WIND_DOWN_TO (default: the new deployer). The old
// contracts are older than this repo's source, so a function may not exist on
// them: every call is simulated from the owner first, and one that would
// revert is reported and skipped, never sent. Default is a dry run.
//
// Env:
//   WIND_DOWN_PRIVATE_KEY   the old contracts' owner key (the NEW_OWNER_PRIVATE_KEY secret)
//   WIND_DOWN_TO            recipient (default TSDeployer 0xAA68…d3a5)
//   WIND_DOWN_STEPS         comma list, default pause,retire,cut,vault,treasury
//   WIND_DOWN_RPC           RPC (default: the public RPC in config.js)
//   WIND_DOWN_FORCE_RETIRE  1 = retire even mid-round
//   GITHUB_STEP_SUMMARY     set by Actions; the report is appended there too
// Args: --execute (send), --self-test

const fs = require("fs");
const { ethers } = require("ethers");
const { configSrc, addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHAIN_ID = 421614;
const DEFAULT_TO = "0xAA6820D22cF59C9d143fe1a943F19FE6EcdAd3a5"; // TSDeployer, new deployer (1 Nov)
// Never a recipient: the two keys leaked on 22 Oct.
const LEAKED = ["0x42536623b503D4926DfAF6173B0357b7DfD19800", "0x490Ae1eC3452c32dA2643715bd310F1eBC87c652"];
const ALL_STEPS = ["pause", "retire", "cut", "vault", "treasury"];
const TOKEN_KEYS = ["WETH", "USDC", "USDT", "LINK", "DAPP"];

const OWNABLE = ["function owner() view returns (address)"];
const PRIZE = [...OWNABLE, "function currentRound() view returns (uint256)", "function currentSegment() view returns (uint256)",
  "function protocolCutAccrued() view returns (uint256)", "function entriesPaused() view returns (bool)",
  "function pauseEntries()", "function retire()", "function withdrawProtocolCut(address)"];
const REGISTRY = [...OWNABLE, "function retireGame()"];
const FAUCET = [...OWNABLE, "function setEthPaused(bool)", "function setTimbsPaused(bool)"];
const VAULT = [...OWNABLE, "function reserve() view returns (uint256)", "function emergencyWithdraw(address,uint256)"];
const TREASURY = [...OWNABLE, "function withdrawToken(address,address,uint256)", "function withdrawOperational(address,uint256)"];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const FACTORY = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];

// ─── Pure helpers (self-tested) ──────────────────────────────────────────────

function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"; }

/** Validated step list from a comma string; unknown names throw. */
function parseSteps(text) {
  const steps = String(text || ALL_STEPS.join(",")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const s of steps) if (!ALL_STEPS.includes(s)) throw new Error(`unknown step "${s}" (steps: ${ALL_STEPS.join(", ")})`);
  return ALL_STEPS.filter((s) => steps.includes(s)); // always in the safe order
}

/** Recipient check: a real address, not a leaked key, not the signer. Returns the checksummed address. */
function checkRecipient(to, signer) {
  const a = ethers.getAddress(String(to).trim().toLowerCase());
  if (a === ethers.ZeroAddress) throw new Error("recipient is the zero address");
  if (LEAKED.includes(a)) throw new Error(`recipient ${short(a)} is a leaked key`);
  if (signer && a === ethers.getAddress(signer)) throw new Error("recipient is the signer itself; send to the new deployer");
  return a;
}

/** Retire only on segment 1 (the previous round has settled), unless forced. */
function retireAllowed(segment, force) {
  return force || Number(segment) === 1;
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
  const throws = (name, fn) => { let t = false; try { fn(); } catch { t = true; } eq(name, t, true); };
  eq("steps default, in order", parseSteps(""), ALL_STEPS);
  eq("steps reordered to the safe order", parseSteps("treasury, cut ,pause"), ["pause", "cut", "treasury"]);
  throws("unknown step throws", () => parseSteps("pause,drain"));
  eq("recipient checksummed", checkRecipient(DEFAULT_TO.toLowerCase(), LEAKED[0]), DEFAULT_TO);
  throws("leaked deployer refused", () => checkRecipient(LEAKED[0], DEFAULT_TO));
  throws("leaked dispatcher refused", () => checkRecipient(LEAKED[1].toLowerCase(), DEFAULT_TO));
  throws("signer as recipient refused", () => checkRecipient(DEFAULT_TO, DEFAULT_TO));
  throws("zero address refused", () => checkRecipient(ethers.ZeroAddress, DEFAULT_TO));
  throws("bad address refused", () => checkRecipient("0x1234", DEFAULT_TO));
  eq("retire on segment 1", retireAllowed(1n, false), true);
  eq("retire mid-round refused", retireAllowed(3n, false), false);
  eq("retire mid-round forced", retireAllowed(3n, true), true);
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const execute = process.argv.includes("--execute");
  const rpcUrl = process.env.WIND_DOWN_RPC || rpcFromConfig();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) throw new Error(`expected Arbitrum Sepolia (${CHAIN_ID}), got chain ${chainId}`);

  const key = (process.env.WIND_DOWN_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("WIND_DOWN_PRIVATE_KEY is not set");
  const signer = new ethers.Wallet(key, provider);
  const to = checkRecipient(process.env.WIND_DOWN_TO || DEFAULT_TO, signer.address);
  const steps = parseSteps(process.env.WIND_DOWN_STEPS);
  const force = process.env.WIND_DOWN_FORCE_RETIRE === "1";
  const src = configSrc();
  const at = (k, abi) => new ethers.Contract(addrFromConfig(k, { src }), abi, signer);

  const out = [];
  const say = (l = "") => { out.push(l); console.log(l); };
  say(`# Old testnet wind-down (${execute ? "RUN" : "dry run"})`);
  say(`Signer ${short(signer.address)} → recipient ${short(to)} · steps: ${steps.join(", ")} · block ${await provider.getBlockNumber()}`);
  say();

  // Build the plan: [{ label, contract, fn, args, value? }]
  const plan = [];
  const notes = [];
  const prize = at("TimbPrize", PRIZE), registry = at("GameRegistry", REGISTRY);

  if (steps.includes("pause")) {
    const paused = await prize.entriesPaused().catch(() => null);
    if (paused === true) notes.push("prize entries already paused");
    else plan.push({ label: "TimbPrize.pauseEntries()", c: prize, fn: "pauseEntries", args: [] });
    const faucet = at("GasFaucet", FAUCET);
    plan.push({ label: "GasFaucet.setEthPaused(true)", c: faucet, fn: "setEthPaused", args: [true] });
    plan.push({ label: "GasFaucet.setTimbsPaused(true)", c: faucet, fn: "setTimbsPaused", args: [true] });
  }
  if (steps.includes("retire")) {
    const [round, segment] = await Promise.all([prize.currentRound(), prize.currentSegment()]);
    if (retireAllowed(segment, force)) {
      plan.push({ label: `TimbPrize.retire()  (round ${round}, segment ${segment})`, c: prize, fn: "retire", args: [] });
      plan.push({ label: "GameRegistry.retireGame()", c: registry, fn: "retireGame", args: [] });
    } else {
      notes.push(`retire held back: round ${round} is on segment ${segment}; it retires once the round has settled and segment 1 of the next is live (or set force_retire)`);
    }
  }
  if (steps.includes("cut")) {
    const cut = await prize.protocolCutAccrued().catch(() => null);
    if (cut === null) notes.push("protocolCutAccrued() not readable on this prize; cut skipped");
    else if (cut === 0n) notes.push("protocol cut is 0");
    else plan.push({ label: `TimbPrize.withdrawProtocolCut(${short(to)})  ${ethers.formatEther(cut)} ETH`, c: prize, fn: "withdrawProtocolCut", args: [to] });
  }
  if (steps.includes("vault")) {
    const vault = at("TimbYieldVault", VAULT);
    const r = await vault.reserve().catch(() => null);
    if (r === null) notes.push("vault reserve() not readable; vault skipped");
    else if (r === 0n) notes.push("vault free reserve is 0");
    else plan.push({ label: `TimbYieldVault.emergencyWithdraw(${short(to)}, ${ethers.formatEther(r)} ETH)`, c: vault, fn: "emergencyWithdraw", args: [to, r] });
  }
  if (steps.includes("treasury")) {
    const treasury = at("TimbTreasury", TREASURY);
    const tAddr = await treasury.getAddress();
    const eth = await provider.getBalance(tAddr);
    if (eth > 0n) plan.push({ label: `TimbTreasury.withdrawOperational(${short(to)}, ${ethers.formatEther(eth)} ETH)`, c: treasury, fn: "withdrawOperational", args: [to, eth] });
    const tokens = [];
    for (const k of TOKEN_KEYS) { try { tokens.push(addrFromConfig(k, { src })); } catch { /* not in config */ } }
    const factory = new ethers.Contract(addrFromConfig("TimbSwapFactory", { src }), FACTORY, provider);
    const n = Number(await factory.allPairsLength());
    for (let i = 0; i < n; i++) tokens.push(await factory.allPairs(i));
    for (const tok of tokens) {
      const c = new ethers.Contract(tok, ERC20, provider);
      const [bal, sym, dec] = await Promise.all([c.balanceOf(tAddr), c.symbol().catch(() => short(tok)), c.decimals().catch(() => 18n)]);
      if (bal > 0n) plan.push({ label: `TimbTreasury.withdrawToken(${sym}, ${short(to)}, ${ethers.formatUnits(bal, dec)})`, c: treasury, fn: "withdrawToken", args: [tok, to, bal] });
    }
  }

  // Owner check, then simulate every call from the signer.
  say(`## Plan`);
  const ok = [];
  for (const p of plan) {
    const owner = await p.c.owner().catch(() => null);
    if (owner && owner !== signer.address) { say(`- SKIP ${p.label}: owner is ${short(owner)}, not the signer`); continue; }
    try {
      await p.c[p.fn].staticCall(...p.args);
      ok.push(p);
      say(`- ok   ${p.label}`);
    } catch (e) {
      say(`- SKIP ${p.label}: would revert (${(e.shortMessage || e.message).slice(0, 140)})`);
    }
  }
  for (const n of notes) say(`- note ${n}`);
  say();

  const before = await provider.getBalance(to);
  if (!execute) {
    say(`Dry run: nothing sent. ${ok.length} call(s) would go out. Run again with mode=run to send.`);
  } else {
    say(`## Sent`);
    let failed = 0;
    // Explicit nonces: back-to-back sends through a node that has not yet
    // indexed the previous tx otherwise reuse one ("nonce has already been used").
    let nonce = await provider.getTransactionCount(signer.address, "pending");
    for (const p of ok) {
      try {
        const tx = await p.c[p.fn](...p.args, { nonce });
        nonce++;
        const rc = await tx.wait();
        say(`- sent ${p.label}  ${rc.hash}`);
      } catch (e) {
        failed++;
        nonce = await provider.getTransactionCount(signer.address, "pending");
        say(`- FAIL ${p.label}: ${(e.shortMessage || e.message).slice(0, 160)}`);
      }
    }
    const after = await provider.getBalance(to);
    say();
    say(`Recipient ${short(to)} ETH: ${ethers.formatEther(before)} → ${ethers.formatEther(after)}`);
    if (failed) { process.exitCode = 1; say(`${failed} call(s) failed; re-run is safe (each step reads the chain again).`); }
  }

  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  main().catch((e) => {
    let msg = e.shortMessage || e.message;
    if (process.env.WIND_DOWN_RPC) msg = msg.split(process.env.WIND_DOWN_RPC).join("<RPC>");
    console.error("wind-down failed:", msg);
    process.exit(1);
  });
}

module.exports = { parseSteps, checkRecipient, retireAllowed, short };
