// redeploy-faucet.js — move the testnet faucet to the self-funded GasFaucet.
//
// The live GasFaucet (config.js GasFaucet) pulls each claim's ETH from
// TimbTreasury. The new build (TestSwap #718) pays claims from its own ETH
// reserve and has no treasury role. This script, signed by the faucet owner
// (TSDeployer):
//   1. reads every setting from the old faucet (drip, pot, TIMBS per claim,
//      cooldown, caps, per-wallet cap, dispatcher, guardian, registry, prize,
//      TIMBS) so the new one matches it,
//   2. deploys the new GasFaucet from the forge artifact,
//   3. sets dispatcher, guardian, ETH and TIMBS caps, per-wallet cap,
//   4. pauses both legs of the old faucet,
//   5. moves the old faucet's TIMBS budget (recoverTimbs) and its ETH
//      (sweepEth) into the new faucet.
// It prints the new address; config.js GasFaucet is updated by a follow-up PR.
//
// Every call is simulated first. Dry run by default (nothing is sent and no
// key is needed: FAUCET_FROM names the owner); --execute sends.
//
// Not migrated: per-wallet cooldowns (lastClaimAt) and lifetime counters start
// fresh, so each ticket holder can claim once straight away on the new faucet.
// The treasury keeps the old faucet as its operator until the treasury owner
// clears it (setOperator(0)); the old faucet is paused, so that role is idle.
//
// Env:
//   FAUCET_RPC        Arbitrum Sepolia RPC (default: config.js public RPC)
//   FAUCET_KEY        owner key (only with --execute)
//   FAUCET_FROM       owner address for the dry run (default: the old owner)
//   FAUCET_EXPECT     address the key must belong to
//   FAUCET_ARTIFACT   forge artifact (default ../out/GasFaucet.sol/GasFaucet.json)
//   FAUCET_OLD        old faucet address (rehearsal only; default config.js)
//   FAUCET_REHEARSAL  set to allow a local chain (rehearsal only)
//
// Flags: --execute (send)

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHAIN_ID = 421614n;

const OLD_ABI = [
  "function owner() view returns (address)",
  "function timbs() view returns (address)", "function registry() view returns (address)",
  "function prize() view returns (address)",
  "function dripEth() view returns (uint256)", "function potEth() view returns (uint256)",
  "function timbsPerClaim() view returns (uint256)", "function cooldown() view returns (uint256)",
  "function ethCap() view returns (uint256)", "function timbsCap() view returns (uint256)",
  "function maxTimbsPerWallet() view returns (uint256)",
  "function dispatcher() view returns (address)", "function guardian() view returns (address)",
  "function ethPaused() view returns (bool)", "function timbsPaused() view returns (bool)",
  "function setEthPaused(bool)", "function setTimbsPaused(bool)",
  "function recoverTimbs(address to, uint256 amount)", "function sweepEth(address to, uint256 amount)",
];
const NEW_ABI_EXTRA = ["function ethReserve() view returns (uint256)"];
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

const fmt = (v) => ethers.formatEther(v);

async function main() {
  const execute = process.argv.includes("--execute");
  const provider = new ethers.JsonRpcProvider(process.env.FAUCET_RPC || rpcFromConfig());
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID && !process.env.FAUCET_REHEARSAL) throw new Error(`wrong chain ${net.chainId}; this is for Arbitrum Sepolia only`);

  // FAUCET_OLD overrides the address (rehearsals only); live runs read config.js.
  const oldAddr = ethers.getAddress(process.env.FAUCET_OLD || addrFromConfig("GasFaucet"));
  const old = new ethers.Contract(oldAddr, OLD_ABI, provider);
  const owner = await old.owner();

  let wallet = null, from;
  if (execute) {
    if (!process.env.FAUCET_KEY) throw new Error("FAUCET_KEY is required with --execute");
    const key = new ethers.Wallet(process.env.FAUCET_KEY, provider);
    from = key.address;
    // Counts nonces locally: back-to-back sends never reuse one.
    wallet = new ethers.NonceManager(key);
    if (process.env.FAUCET_EXPECT && from !== ethers.getAddress(process.env.FAUCET_EXPECT)) {
      throw new Error(`the key belongs to ${from}, not ${process.env.FAUCET_EXPECT}`);
    }
  } else {
    from = ethers.getAddress(process.env.FAUCET_FROM || owner);
  }
  if (from !== owner) throw new Error(`signer ${from} is not the old faucet's owner ${owner}`);

  // ── 1. Read the old faucet ──
  const [timbs, registry, prize, drip, pot, perClaim, cooldown, ethCap, timbsCap, perWallet, dispatcher, guardian] =
    await Promise.all([old.timbs(), old.registry(), old.prize(), old.dripEth(), old.potEth(), old.timbsPerClaim(),
      old.cooldown(), old.ethCap(), old.timbsCap(), old.maxTimbsPerWallet(), old.dispatcher(), old.guardian()]);
  const oldTimbs = await new ethers.Contract(timbs, ERC20, provider).balanceOf(oldAddr);
  const oldEth = await provider.getBalance(oldAddr);

  console.log(`old GasFaucet ${oldAddr} (owner ${owner})`);
  console.log(`  drip ${fmt(drip)} ETH · pot ${fmt(pot)} ETH · ${fmt(perClaim)} TIMBS/claim · cooldown ${cooldown}s`);
  console.log(`  caps ${fmt(ethCap)} ETH / ${fmt(timbsCap)} TIMBS · per-wallet ${fmt(perWallet)} · dispatcher ${dispatcher} · guardian ${guardian}`);
  console.log(`  holds ${fmt(oldEth)} ETH and ${fmt(oldTimbs)} TIMBS → both move to the new faucet`);

  // ── 2. The new build ──
  const artPath = process.env.FAUCET_ARTIFACT || path.join(__dirname, "..", "out", "GasFaucet.sol", "GasFaucet.json");
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));
  const abi = art.abi;
  if (abi.some((x) => x.type === "function" && x.name === "treasury")) {
    throw new Error("artifact still has treasury(): build from main after #718");
  }
  if (!abi.some((x) => x.type === "function" && x.name === "ethReserve")) {
    throw new Error("artifact has no ethReserve(): wrong GasFaucet build");
  }
  const bytecode = art.bytecode?.object || art.bytecode;
  const factory = new ethers.ContractFactory(abi, bytecode, wallet ?? provider);
  const args = [timbs, registry, prize, drip, pot, perClaim, cooldown];
  const deployTx = await factory.getDeployTransaction(...args);
  const gas = await provider.estimateGas({ ...deployTx, from });
  console.log(`\nnew GasFaucet(${args.join(", ")})  deploy gas ≈ ${gas}`);

  const plan = [
    "deploy the new GasFaucet",
    `new.setDispatcher(${dispatcher})`,
    guardian !== ethers.ZeroAddress ? `new.setGuardian(${guardian})` : null,
    `new.setEthCap(${fmt(ethCap)} ETH)`,
    `new.setTimbsCap(${fmt(timbsCap)} TIMBS)`,
    perWallet > 0n ? `new.setMaxTimbsPerWallet(${fmt(perWallet)})` : null,
    "old.setEthPaused(true)", "old.setTimbsPaused(true)",
    oldTimbs > 0n ? `old.recoverTimbs(new, ${fmt(oldTimbs)} TIMBS)` : null,
    oldEth > 0n ? `old.sweepEth(new, ${fmt(oldEth)} ETH)` : null,
  ].filter(Boolean);
  console.log("\nplan:\n" + plan.map((s, i) => `  ${i + 1}. ${s}`).join("\n"));

  // The old-faucet calls can be simulated now; the new-faucet ones only after it exists.
  for (const [fn, a] of [["setEthPaused", [true]], ["setTimbsPaused", [true]]]) {
    await old[fn].staticCall(...a, { from });
  }
  if (oldTimbs > 0n) await old.recoverTimbs.staticCall(from, oldTimbs, { from });
  if (oldEth > 0n) await old.sweepEth.staticCall(from, oldEth, { from });
  console.log("old-faucet calls simulate cleanly.");

  if (!execute) { console.log("\nDRY RUN — nothing sent. Re-run with --execute."); return; }

  // ── 3. Execute ──
  const send = async (label, p) => { const tx = await p; console.log(`  ${label}  ${tx.hash}`); await tx.wait(); };
  const deployed = await factory.deploy(...args);
  console.log(`  deploy  ${deployed.deploymentTransaction().hash}`);
  await deployed.waitForDeployment();
  const newAddr = await deployed.getAddress();
  const nf = new ethers.Contract(newAddr, [...abi, ...NEW_ABI_EXTRA], wallet);
  const oldW = old.connect(wallet);

  await send("setDispatcher", nf.setDispatcher(dispatcher));
  if (guardian !== ethers.ZeroAddress) await send("setGuardian", nf.setGuardian(guardian));
  await send("setEthCap", nf.setEthCap(ethCap));
  await send("setTimbsCap", nf.setTimbsCap(timbsCap));
  if (perWallet > 0n) await send("setMaxTimbsPerWallet", nf.setMaxTimbsPerWallet(perWallet));
  if (!(await old.ethPaused())) await send("old.setEthPaused", oldW.setEthPaused(true));
  if (!(await old.timbsPaused())) await send("old.setTimbsPaused", oldW.setTimbsPaused(true));
  if (oldTimbs > 0n) await send("old.recoverTimbs", oldW.recoverTimbs(newAddr, oldTimbs));
  if (oldEth > 0n) await send("old.sweepEth", oldW.sweepEth(newAddr, oldEth));

  // ── 4. Read back ──
  const [d, g, ec, tc, res, tb] = await Promise.all([nf.dispatcher(), nf.guardian(), nf.ethCap(), nf.timbsCap(),
    nf.ethReserve(), new ethers.Contract(timbs, ERC20, provider).balanceOf(newAddr)]);
  const ok = d === dispatcher && g === guardian && ec === ethCap && tc === timbsCap;
  console.log(`\nnew GasFaucet ${newAddr}`);
  console.log(`  dispatcher ${d} · guardian ${g} · caps ${fmt(ec)} ETH / ${fmt(tc)} TIMBS`);
  console.log(`  reserve ${fmt(res)} ETH · ${fmt(tb)} TIMBS · wiring ${ok ? "matches the old faucet" : "MISMATCH"}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## New GasFaucet\n\n\`${newAddr}\`\n\n- reserve ${fmt(res)} ETH, ${fmt(tb)} TIMBS\n- wiring ${ok ? "matches" : "**MISMATCH**"}\n` +
      `- next: set config.js GasFaucet to this address (PR), then rebuild the site zip\n`);
  }
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(`::error::${e.shortMessage || e.message}`); process.exit(1); });
