// handoff-roles.js — give the epoch keeper its roles on the testnet v2 set.
//
// The 2 Nov redeploy left every contract owned by TSDeployer. The epoch keeper
// (scripts/epoch.js) needs:
//   • TimbTreasury ownership: executeBuyback, distributeToStaking and
//     withdrawToken are onlyOwner. TimbTreasury is Ownable2Step, so this is
//     two transactions: the owner proposes, the keeper wallet accepts.
//   • rewardNotifier on TimbFarm, TimbStaking and TimbBoostFarm, so it can
//     notifyRewardAmount on each.
//
// Two steps, run in order:
//   grant   signed by the owner (TSDeployer): TimbTreasury.transferOwnership,
//           then setRewardNotifier(epoch, true) on the three pools.
//   accept  signed by the epoch keeper's key: TimbTreasury.acceptOwnership.
//
// Every call is simulated first (staticCall) and skipped when it is already
// done, so a rerun is safe. Dry run by default; --execute sends.
//
// The epoch address is refused if it is zero, a leaked key, the old owner
// wallet, the signer, or a wallet that already holds a keeper role (settler,
// faucet dispatcher, faucet guardian): one key per role.
//
// Env:
//   HANDOFF_RPC          Arbitrum Sepolia RPC (default: config.js public RPC)
//   HANDOFF_STEP         grant | accept
//   HANDOFF_EPOCH        the epoch keeper wallet address
//   HANDOFF_KEY          signer key: the owner's for grant, the epoch keeper's for accept
//   HANDOFF_EXPECT       address the key must belong to
//
// Flags: --self-test (no network)  --execute (send)

"use strict";

const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHAIN_ID = 421614n;
const LEAKED = ["0x42536623b503D4926DfAF6173B0357b7DfD19800", "0x490Ae1eC3452c32dA2643715bd310F1eBC87c652"];
const OLD_OWNER = "0xF27B6fF61Fce2B11889AD130cDE443093bC2d8f2";

const TREASURY = ["function owner() view returns (address)", "function pendingOwner() view returns (address)",
  "function transferOwnership(address)", "function acceptOwnership()"];
const POOL = ["function owner() view returns (address)", "function rewardNotifiers(address) view returns (bool)",
  "function setRewardNotifier(address,bool)"];
const PRIZE = ["function settler() view returns (address)"];
const FAUCET = ["function dispatcher() view returns (address)", "function guardian() view returns (address)"];

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The epoch address, checksummed, or a throw naming why it is refused. */
function checkEpoch(addr, { signer, roles = {} } = {}) {
  let a;
  try { a = ethers.getAddress(String(addr).trim().toLowerCase()); } catch { throw new Error(`not an address: ${addr}`); }
  if (a === ethers.ZeroAddress) throw new Error("epoch keeper is the zero address");
  if (LEAKED.includes(a)) throw new Error(`epoch keeper ${short(a)} is a leaked key`);
  if (a === OLD_OWNER) throw new Error(`epoch keeper ${short(a)} is the old owner wallet (TSW001)`);
  if (signer && a === ethers.getAddress(signer)) throw new Error("epoch keeper is the owner itself; use a fresh wallet");
  for (const [role, holder] of Object.entries(roles)) {
    if (holder && a === ethers.getAddress(holder)) throw new Error(`epoch keeper ${short(a)} already holds the ${role} role`);
  }
  return a;
}

/** The grant step's calls, given what is already on chain. */
function planGrant({ treasuryOwner, pendingOwner, notifiers }, epoch) {
  const out = [];
  if (treasuryOwner === epoch) out.push({ skip: "TimbTreasury already owned by the epoch keeper" });
  else if (pendingOwner === epoch) out.push({ skip: "TimbTreasury transfer already proposed; run accept" });
  else out.push({ target: "TimbTreasury", fn: "transferOwnership", args: [epoch] });
  for (const [name, on] of Object.entries(notifiers)) {
    if (on) out.push({ skip: `${name} already has the epoch keeper as rewardNotifier` });
    else out.push({ target: name, fn: "setRewardNotifier", args: [epoch, true] });
  }
  return out;
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`); } };
  const throws = (n, f) => { try { f(); fail++; console.log(`FAIL ${n}: did not throw`); } catch { pass++; } };
  const E = "0x1111111111111111111111111111111111111111", O = "0xAA6820D22cF59C9d143fe1a943F19FE6EcdAd3a5";
  const S = "0x498ECe3f20AF71496E0FE29667fb4435137639dF";
  eq("fresh address accepted, checksummed", checkEpoch(E.toLowerCase(), { signer: O }), E);
  throws("zero refused", () => checkEpoch(ethers.ZeroAddress, { signer: O }));
  throws("leaked refused", () => checkEpoch(LEAKED[0], { signer: O }));
  throws("old owner refused", () => checkEpoch(OLD_OWNER.toLowerCase(), { signer: O }));
  throws("signer refused", () => checkEpoch(O, { signer: O }));
  throws("settler refused", () => checkEpoch(S, { signer: O, roles: { settler: S } }));
  throws("garbage refused", () => checkEpoch("0x1234", { signer: O }));
  const none = { TimbFarm: false, TimbStaking: false, TimbBoostFarm: false };
  eq("fresh: four calls", planGrant({ treasuryOwner: O, pendingOwner: ethers.ZeroAddress, notifiers: none }, E).filter((p) => p.fn).length, 4);
  eq("proposed: transfer skipped", planGrant({ treasuryOwner: O, pendingOwner: E, notifiers: none }, E)[0].skip !== undefined, true);
  eq("done: nothing to send", planGrant({ treasuryOwner: E, pendingOwner: ethers.ZeroAddress,
    notifiers: { TimbFarm: true, TimbStaking: true, TimbBoostFarm: true } }, E).filter((p) => p.fn).length, 0);
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function main() {
  const EXECUTE = process.argv.includes("--execute");
  const step = (process.env.HANDOFF_STEP || "").trim();
  if (!["grant", "accept"].includes(step)) throw new Error(`HANDOFF_STEP must be grant or accept, not "${step}"`);
  if (!process.env.HANDOFF_KEY) throw new Error("HANDOFF_KEY not set");

  const provider = new ethers.JsonRpcProvider(process.env.HANDOFF_RPC || rpcFromConfig());
  const { chainId } = await provider.getNetwork();
  if (chainId !== CHAIN_ID) throw new Error(`chain ${chainId} is not Arbitrum Sepolia`);
  const signer = new ethers.Wallet(process.env.HANDOFF_KEY, provider);
  if (process.env.HANDOFF_EXPECT && signer.address !== ethers.getAddress(process.env.HANDOFF_EXPECT.trim())) {
    throw new Error(`the key belongs to ${signer.address}, not ${process.env.HANDOFF_EXPECT.trim()}`);
  }

  const addr = { TimbTreasury: addrFromConfig("TimbTreasury"), TimbFarm: addrFromConfig("TimbFarm"),
    TimbStaking: addrFromConfig("TimbStaking"), TimbBoostFarm: addrFromConfig("TimbBoostFarm") };
  const treasury = new ethers.Contract(addr.TimbTreasury, TREASURY, signer);
  const pools = Object.fromEntries(["TimbFarm", "TimbStaking", "TimbBoostFarm"].map((n) => [n, new ethers.Contract(addr[n], POOL, signer)]));
  const prize = new ethers.Contract(addrFromConfig("TimbPrize"), PRIZE, provider);
  const faucet = new ethers.Contract(addrFromConfig("GasFaucet"), FAUCET, provider);

  const [treasuryOwner, pendingOwner, settler, dispatcher, guardian] = await Promise.all([
    treasury.owner(), treasury.pendingOwner(), prize.settler(), faucet.dispatcher(), faucet.guardian()]);
  const owner = step === "grant" ? signer.address : treasuryOwner;
  const epoch = checkEpoch(process.env.HANDOFF_EPOCH, { signer: owner, roles: { settler, "faucet dispatcher": dispatcher, "faucet guardian": guardian } });

  console.log(`handoff-roles  step ${step}  mode ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  signer        ${signer.address}`);
  console.log(`  epoch keeper  ${epoch}`);
  console.log(`  TimbTreasury  ${addr.TimbTreasury}  owner ${treasuryOwner}  pending ${pendingOwner}`);

  let plan;
  if (step === "grant") {
    if (treasuryOwner !== signer.address && treasuryOwner !== epoch) throw new Error(`TimbTreasury is owned by ${treasuryOwner}, not the signer`);
    const notifiers = {};
    for (const [n, c] of Object.entries(pools)) {
      const [o, on] = await Promise.all([c.owner(), c.rewardNotifiers(epoch)]);
      console.log(`  ${n.padEnd(13)} ${addr[n]}  owner ${o}  epoch notifier ${on ? "yes" : "no"}`);
      if (!on && o !== signer.address) throw new Error(`${n} is owned by ${o}, not the signer`);
      notifiers[n] = on;
    }
    plan = planGrant({ treasuryOwner, pendingOwner, notifiers }, epoch);
  } else {
    if (signer.address !== epoch) throw new Error(`accept must be signed by the epoch keeper ${epoch}, not ${signer.address}`);
    plan = treasuryOwner === epoch ? [{ skip: "TimbTreasury already owned by the epoch keeper" }]
      : pendingOwner === epoch ? [{ target: "TimbTreasury", fn: "acceptOwnership", args: [] }]
      : (() => { throw new Error(`no transfer to ${epoch} is pending (pending: ${pendingOwner}); run grant first`); })();
  }

  console.log("\nplan:");
  const calls = [];
  for (const p of plan) {
    if (p.skip) { console.log(`  - skip  ${p.skip}`); continue; }
    const c = p.target === "TimbTreasury" ? treasury : pools[p.target];
    await c[p.fn].staticCall(...p.args); // throws with the revert reason if it would fail
    console.log(`  - ${p.target}.${p.fn}(${p.args.map(String).join(", ")})  simulated OK`);
    calls.push({ c, ...p });
  }
  if (!EXECUTE) { console.log(`\nDRY RUN: ${calls.length} call(s) would be sent. Nothing sent.`); return; }

  // Explicit nonces: back-to-back sends through a node that has not yet
  // indexed the previous tx otherwise reuse one.
  let nonce = await provider.getTransactionCount(signer.address, "pending");
  for (const p of calls) {
    const tx = await p.c[p.fn](...p.args, { nonce });
    nonce++;
    const r = await tx.wait();
    console.log(`  sent ${p.target}.${p.fn}  ${tx.hash}  block ${r.blockNumber}`);
  }

  const [o2, p2] = await Promise.all([treasury.owner(), treasury.pendingOwner()]);
  console.log(`\nread-back: TimbTreasury owner ${o2}  pending ${p2}`);
  for (const [n, c] of Object.entries(pools)) console.log(`read-back: ${n} epoch notifier ${await c.rewardNotifiers(epoch)}`);
  if (step === "accept" && o2 !== epoch) throw new Error("TimbTreasury owner did not change");
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) selfTest();
  else main().catch((e) => { console.error(`::error::${e.shortMessage || e.message}`); process.exit(1); });
}

module.exports = { checkEpoch, planGrant };
