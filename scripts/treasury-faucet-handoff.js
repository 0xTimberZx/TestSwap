// treasury-faucet-handoff.js — finish separating the faucet from TimbTreasury.
//
// After the self-funded GasFaucet (#718/#719/#720) the treasury still lists the
// old faucet as its operator with a 0.1 ETH window cap, and holds ETH that was
// sent there to fund faucet claims. Signed by the treasury OWNER (the epoch
// keeper wallet), this:
//   1. moves treasury ETH to the faucet in config.js (withdrawOperational: the
//      owner is uncapped). Amount: TREASURY_FAUCET_ETH, or "all" (default) for
//      the whole balance at run time,
//   2. clears the operator (setOperator(0)),
//   3. sets the operator cap to 0 (setOperatorEthCap(0, current period)), so the
//      epoch buyback's reserve (it keeps operatorEthCap) drops to 0 as well.
// Each step is skipped when already done; every call is simulated first. Dry
// run by default (no key: TREASURY_FROM names the owner); --execute sends.
//
// Env:
//   TREASURY_RPC         Arbitrum Sepolia RPC (default: config.js public RPC)
//   TREASURY_KEY         owner key (only with --execute)
//   TREASURY_FROM        owner address for the dry run (default: the owner)
//   TREASURY_EXPECT      address the key must belong to
//   TREASURY_FAUCET_ETH  ETH to move, e.g. "0.105", or "all" (default), or "0" to skip
//
// Flags: --execute (send)

"use strict";

const fs = require("fs");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHAIN_ID = 421614n;
const TREASURY_ABI = [
  "function owner() view returns (address)", "function operator() view returns (address)",
  "function operatorEthCap() view returns (uint256)", "function operatorPeriod() view returns (uint256)",
  "function withdrawOperational(address to, uint256 amount)",
  "function setOperator(address)", "function setOperatorEthCap(uint256 cap, uint256 period)",
];
const FAUCET_ABI = ["function ethReserve() view returns (uint256)", "function dispatcher() view returns (address)"];

const fmt = (v) => ethers.formatEther(v);

async function main() {
  const execute = process.argv.includes("--execute");
  const provider = new ethers.JsonRpcProvider(process.env.TREASURY_RPC || rpcFromConfig());
  if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error("Arbitrum Sepolia only");

  const treasuryAddr = addrFromConfig("TimbTreasury");
  const faucetAddr = addrFromConfig("GasFaucet");
  const treasury = new ethers.Contract(treasuryAddr, TREASURY_ABI, provider);
  const faucet = new ethers.Contract(faucetAddr, FAUCET_ABI, provider);

  // The destination must be the self-funded build: it has ethReserve().
  try { await faucet.ethReserve(); } catch { throw new Error(`config.js GasFaucet ${faucetAddr} has no ethReserve(): not the self-funded faucet`); }

  const owner = await treasury.owner();
  let wallet = null, from;
  if (execute) {
    if (!process.env.TREASURY_KEY) throw new Error("TREASURY_KEY is required with --execute");
    const key = new ethers.Wallet(process.env.TREASURY_KEY, provider);
    from = key.address;
    if (process.env.TREASURY_EXPECT && from !== ethers.getAddress(process.env.TREASURY_EXPECT)) {
      throw new Error(`the key belongs to ${from}, not ${process.env.TREASURY_EXPECT}`);
    }
    wallet = new ethers.NonceManager(key);
  } else {
    from = ethers.getAddress(process.env.TREASURY_FROM || owner);
  }
  if (from !== owner) throw new Error(`signer ${from} is not the treasury owner ${owner}`);

  const [bal, op, cap, period, reserve] = await Promise.all([provider.getBalance(treasuryAddr), treasury.operator(),
    treasury.operatorEthCap(), treasury.operatorPeriod(), faucet.ethReserve()]);
  const want = (process.env.TREASURY_FAUCET_ETH || "all").trim().toLowerCase();
  const amount = want === "all" ? bal : ethers.parseEther(want);
  if (amount > bal) throw new Error(`asked to move ${fmt(amount)} ETH but the treasury holds ${fmt(bal)}`);

  console.log(`TimbTreasury ${treasuryAddr} (owner ${owner})`);
  console.log(`  holds ${fmt(bal)} ETH · operator ${op} · operator cap ${fmt(cap)} ETH per ${period}s`);
  console.log(`GasFaucet ${faucetAddr} · reserve ${fmt(reserve)} ETH`);

  const steps = [];
  if (amount > 0n) steps.push({ label: `withdrawOperational(faucet, ${fmt(amount)} ETH)`, fn: "withdrawOperational", args: [faucetAddr, amount] });
  if (op !== ethers.ZeroAddress) steps.push({ label: `setOperator(0x0) (was ${op})`, fn: "setOperator", args: [ethers.ZeroAddress] });
  if (cap !== 0n) steps.push({ label: `setOperatorEthCap(0, ${period}) (was ${fmt(cap)} ETH)`, fn: "setOperatorEthCap", args: [0n, period] });
  if (!steps.length) { console.log("\nnothing to do: already handed off."); return; }

  console.log("\nplan:\n" + steps.map((s, i) => `  ${i + 1}. ${s.label}`).join("\n"));
  for (const s of steps) await treasury[s.fn].staticCall(...s.args, { from });
  console.log("all calls simulate cleanly.");
  if (!execute) { console.log("\nDRY RUN — nothing sent. Re-run with --execute."); return; }

  const tw = treasury.connect(wallet);
  for (const s of steps) {
    const tx = await tw[s.fn](...s.args);
    console.log(`  ${s.label}  ${tx.hash}`);
    await tx.wait();
  }

  const [bal2, op2, cap2, res2] = await Promise.all([provider.getBalance(treasuryAddr), treasury.operator(),
    treasury.operatorEthCap(), faucet.ethReserve()]);
  const ok = op2 === ethers.ZeroAddress && cap2 === 0n;
  console.log(`\nafter: treasury ${fmt(bal2)} ETH · operator ${op2} · cap ${fmt(cap2)} · faucet reserve ${fmt(res2)} ETH`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Treasury ↔ faucet handoff\n\n- faucet reserve **${fmt(res2)} ETH**\n- treasury ${fmt(bal2)} ETH, operator ${op2}, cap ${fmt(cap2)}\n- ${ok ? "done" : "**operator or cap not cleared**"}\n`);
  }
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(`::error::${e.shortMessage || e.message}`); process.exit(1); });
