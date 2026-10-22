// rotate-owner.js — one-off admin: move every Sepolia role held by a leaked key
// to fresh keys (Railway incident, 22 October 2026).
//
// Railway disclosed that customer environment variables may have been read, so
// every key that sat there is treated as public: the deployer key (which was
// also SETTLER_PRIVATE_KEY) and the faucet dispatcher key. This script finds
// everything those keys control on Arbitrum Sepolia and hands it over:
//
//   Phase 1, signed by the leaked key that holds each role:
//     - role setters, while the leaked key is still owner:
//         settler, dispatcher, operator      -> KEEPER (the new hot key)
//         guardian, seedFunder, protocolSink -> the new owner
//     - transferOwnership(new owner) on every contract a leaked key owns
//     - requestSubscriptionOwnerTransfer on every VRF subscription it owns
//     - sweep the leaked wallets' Sepolia ETH to the new owner (gas for phase 2)
//   Phase 2, signed by the new owner key:
//     - acceptOwnership wherever the transfer is two-step
//     - acceptSubscriptionOwnerTransfer on each VRF subscription
//   Then it reads everything back and exits 1 if a leaked key still holds a role.
//
// Contracts scanned: every address in config.js (live set plus the "Prev:"
// generations in its comments) and the retired SwapTables generations listed
// in check-roles.js. Retired contracts stay in scope because their ledgers
// still pay out. An address with no owner() (a token, an EOA) is skipped.
//
// Usage (GitHub Actions "Admin — Rotate Keys" workflow, or locally):
//   KEEPER=0x... node scripts/rotate-owner.js [--dry-run]
//
//   DEPLOYER_PRIVATE_KEY, SETTLER_PRIVATE_KEY, FAUCET_DISPATCHER_PRIVATE_KEY
//                         the leaked keys (any may be unset; duplicates are fine)
//   NEW_OWNER_PRIVATE_KEY the fresh owner key. Its address is derived here, so
//                         a one-step transferOwnership can never go to an
//                         address nobody holds.
//   KEEPER                the fresh hot key's ADDRESS (settler, dispatcher,
//                         operator). Its private key goes into the keepers'
//                         secrets afterwards, never into this workflow.
//   LEAKED_EXTRA          optional comma-separated addresses of other leaked
//                         keys this run cannot sign for; roles they hold are
//                         reported, not moved.
//   ARB_SEPOLIA_RPC       optional; defaults to the public Sepolia node.
//
// --dry-run reads everything, simulates every phase-1 transaction from the
// signer that would send it, prints the plan, and sends nothing.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const CHAIN   = Number(process.env.CHAIN_ID || 421614); // tests run on a local anvil
const GAS_RESERVE = ethers.parseEther("0.0005"); // left in each leaked wallet for the sweep tx itself

// Role getter -> setter, and which new address takes it.
const ROLES = [
  { get: "settler",      set: "setSettler",      to: "keeper" },
  { get: "dispatcher",   set: "setDispatcher",   to: "keeper" },
  { get: "operator",     set: "setOperator",     to: "keeper" },
  { get: "guardian",     set: "setGuardian",     to: "owner"  },
  { get: "seedFunder",   set: "setSeedFunder",   to: "owner"  },
  { get: "protocolSink", set: "setProtocolSink", to: "owner"  },
];

const ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
  "function acceptOwnership()",
  "function coordinator() view returns (address)",
  "function subId() view returns (uint256)",
  "function rewardNotifiers(address) view returns (bool)",
  ...ROLES.flatMap(r => [`function ${r.get}() view returns (address)`, `function ${r.set}(address)`]),
];
const COORD_ABI = [
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
  "function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner)",
  "function acceptSubscriptionOwnerTransfer(uint256 subId)",
];

const lc = a => (a || "").toLowerCase();
const short = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "none";

/** Every address in config.js and check-roles.js, deduplicated and checksummed. */
function candidateAddresses() {
  const files = process.env.ROTATE_ADDRESS_FILES // tests point this at a fixture
    ? process.env.ROTATE_ADDRESS_FILES.split(",")
    : [path.join(__dirname, "..", "config.js"), path.join(__dirname, "check-roles.js")];
  const seen = new Map();
  for (const f of files) {
    for (const [m] of fs.readFileSync(f, "utf8").matchAll(/0x[a-fA-F0-9]{40}\b/g)) {
      const a = ethers.getAddress(m.toLowerCase());
      if (a !== ethers.ZeroAddress) seen.set(lc(a), a);
    }
  }
  return [...seen.values()];
}

/** A read that returns null when the contract has no such function. */
async function tryRead(c, fn, ...args) {
  try { return await c[fn](...args); } catch { return null; }
}

async function main() {
  // cacheTimeout -1: ethers otherwise reuses an eth_getTransactionCount answer
  // for 250 ms, so back-to-back sends from one key collide on the same nonce.
  // Every read below treats a failure as "no such function", so a dead RPC would
  // look like a clean scan: prove the chain answers first. A keyed RPC that was
  // revoked in the same incident (401) falls back to the public node.
  let RPC = process.env.ARB_SEPOLIA_RPC || PUBLIC_RPC;
  let provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, cacheTimeout: -1 });
  try {
    await provider.getBlockNumber();
  } catch (e) {
    if (RPC === PUBLIC_RPC) throw e;
    console.log(`ARB_SEPOLIA_RPC failed (${e.shortMessage || e.message}); using the public node`);
    RPC = PUBLIC_RPC;
    provider = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true, cacheTimeout: -1 });
    await provider.getBlockNumber();
  }

  // ── Keys ──
  const leakedSigners = new Map(); // lc(address) -> Wallet
  for (const name of ["DEPLOYER_PRIVATE_KEY", "SETTLER_PRIVATE_KEY", "FAUCET_DISPATCHER_PRIVATE_KEY"]) {
    const k = (process.env[name] || "").trim();
    if (!k) { console.log(`${name}: not set`); continue; }
    const w = new ethers.Wallet(k, provider);
    console.log(`${name}: ${w.address}`);
    leakedSigners.set(lc(w.address), w);
  }
  const leaked = new Set(leakedSigners.keys());
  for (const a of (process.env.LEAKED_EXTRA || "").split(",").map(s => s.trim()).filter(Boolean)) {
    leaked.add(lc(ethers.getAddress(a)));
  }
  if (!leaked.size) throw new Error("no leaked key or address given — nothing to rotate");

  const newKey = (process.env.NEW_OWNER_PRIVATE_KEY || "").trim();
  if (!newKey) throw new Error("NEW_OWNER_PRIVATE_KEY is not set");
  const newOwner = new ethers.Wallet(newKey, provider);
  if (leaked.has(lc(newOwner.address))) throw new Error("the new owner key is one of the leaked keys");

  // Strict checksum on purpose: a typo here hands the settler and dispatcher
  // roles to an address nobody holds. Paste it from the wallet, don't retype it.
  let keeper;
  try { keeper = ethers.getAddress((process.env.KEEPER || "").trim()); }
  catch { throw new Error(`KEEPER "${process.env.KEEPER || ""}" is not a valid address (copy it from the wallet; a mixed-case address must match its checksum)`); }
  if (leaked.has(lc(keeper))) throw new Error("KEEPER is one of the leaked keys");
  const target = { owner: newOwner.address, keeper };

  console.log(`\nnew owner : ${newOwner.address}`);
  console.log(`keeper    : ${keeper}${lc(keeper) === lc(newOwner.address) ? "  (same as the new owner: works, but one leak would cost both)" : ""}`);
  console.log(`leaked    : ${[...leaked].map(short).join(", ")}`);
  console.log(`rpc       : ${new URL(RPC).host}`); // host only: a keyed path is a secret
  console.log(DRY_RUN ? "mode      : DRY RUN — nothing is sent\n" : "mode      : RUN\n");

  // ── Scan ──
  const plan = [];      // phase-1 txs: { signer, contract, label, fn, args }
  const stuck = [];     // roles held by a leaked key whose owner we cannot sign for
  const owned = [];     // contracts a leaked signer owns (for phase 2 and the read-back)
  const subs = new Map(); // `${coord}:${subId}` -> { coord, subId, owner }
  const notifiers = [];

  const addrs = candidateAddresses();
  console.log(`scanning ${addrs.length} addresses from config.js and check-roles.js`);
  for (const addr of addrs) {
    const c = new ethers.Contract(addr, ABI, provider);
    const owner = await tryRead(c, "owner");
    if (!owner) continue; // not an Ownable contract (token, EOA, pair)

    const ownerSigner = leakedSigners.get(lc(owner));
    if (ownerSigner) owned.push({ addr, signer: ownerSigner });

    for (const r of ROLES) {
      const holder = await tryRead(c, r.get);
      if (!holder || !leaked.has(lc(holder))) continue;
      const to = target[r.to];
      if (ownerSigner) {
        plan.push({ signer: ownerSigner, addr, label: `${short(addr)} ${r.set}(${short(to)})  was ${short(holder)}`, fn: r.set, args: [to] });
      } else {
        stuck.push(`${addr} ${r.get}=${holder} — owner ${owner} is not a key this run holds`);
      }
    }

    for (const l of leaked) {
      if (await tryRead(c, "rewardNotifiers", l)) notifiers.push(`${addr} rewardNotifiers[${l}] = true`);
    }

    const coord = await tryRead(c, "coordinator");
    const subId = coord ? await tryRead(c, "subId") : null;
    if (coord && subId !== null && !subs.has(`${lc(coord)}:${subId}`)) {
      const sc = new ethers.Contract(coord, COORD_ABI, provider);
      const sub = await tryRead(sc, "getSubscription", subId);
      if (sub) subs.set(`${lc(coord)}:${subId}`, { coord, subId, owner: sub.subOwner });
    }

    if (ownerSigner) {
      plan.push({ signer: ownerSigner, addr, label: `${short(addr)} transferOwnership(${short(newOwner.address)})  was ${short(owner)}`, fn: "transferOwnership", args: [newOwner.address] });
    }
  }

  if (!owned.length && !stuck.length) {
    console.log("\nno contract is owned by a leaked key. If that is unexpected, check the RPC and the key secrets.");
  }

  const subPlan = [];
  for (const s of subs.values()) {
    const signer = leakedSigners.get(lc(s.owner));
    if (signer) subPlan.push({ ...s, signer });
    else if (leaked.has(lc(s.owner))) stuck.push(`VRF sub ${s.subId} on ${s.coord} — owner ${s.owner} is not a key this run holds`);
  }

  console.log(`\n── Phase 1 (${plan.length + subPlan.length} transactions from the leaked keys)`);
  for (const p of plan) console.log(`  [${short(p.signer.address)}] ${p.label}`);
  for (const s of subPlan) console.log(`  [${short(s.signer.address)}] VRF sub ${s.subId}: requestSubscriptionOwnerTransfer(${short(newOwner.address)})`);
  console.log(`  then sweep each leaked wallet's Sepolia ETH to ${short(newOwner.address)} (keeping ${ethers.formatEther(GAS_RESERVE)} ETH for gas)`);
  if (stuck.length) {
    console.log("\n── Held by a leaked key, but this run cannot move it:");
    for (const s of stuck) console.log(`  ${s}`);
  }
  if (notifiers.length) {
    console.log("\n── For information (reward notifiers can only fund rewards; left as they are):");
    for (const n of notifiers) console.log(`  ${n}`);
  }

  if (DRY_RUN) {
    console.log("\n── Simulating phase 1 from each signer");
    let fails = 0;
    for (const p of plan) {
      const c = new ethers.Contract(p.addr, ABI, p.signer);
      try { await c[p.fn].staticCall(...p.args); console.log(`  ok    ${p.label}`); }
      catch (e) { fails++; console.log(`  FAIL  ${p.label}: ${e.shortMessage || e.message}`); }
    }
    for (const s of subPlan) {
      const sc = new ethers.Contract(s.coord, COORD_ABI, s.signer);
      try { await sc.requestSubscriptionOwnerTransfer.staticCall(s.subId, newOwner.address); console.log(`  ok    VRF sub ${s.subId}`); }
      catch (e) { fails++; console.log(`  FAIL  VRF sub ${s.subId}: ${e.shortMessage || e.message}`); }
    }
    for (const w of leakedSigners.values()) {
      console.log(`  ${short(w.address)} balance ${ethers.formatEther(await provider.getBalance(w.address))} ETH`);
    }
    if (fails) console.log(`\n${fails} simulated transaction(s) would revert — fix before a real run.`);
    else if (!plan.length && !subPlan.length) console.log("\nnothing left for the leaked keys to hand over.");
    else console.log("\nevery phase-1 transaction simulates cleanly. Re-run with mode = run.");
    if (stuck.length) console.log(`${stuck.length} role(s) need their owner to move them (listed above).`);
    process.exit(fails || stuck.length ? 1 : 0);
  }

  // ── Phase 1 ──
  console.log("\n── Phase 1: sending");
  for (const p of plan) {
    const c = new ethers.Contract(p.addr, ABI, p.signer);
    try {
      const tx = await c[p.fn](...p.args);
      await tx.wait();
      console.log(`  sent  ${p.label}  ${tx.hash}`);
    } catch (e) {
      console.log(`  FAIL  ${p.label}: ${e.shortMessage || e.message}`);
    }
  }
  for (const s of subPlan) {
    const sc = new ethers.Contract(s.coord, COORD_ABI, s.signer);
    try {
      const tx = await sc.requestSubscriptionOwnerTransfer(s.subId, newOwner.address);
      await tx.wait();
      console.log(`  sent  VRF sub ${s.subId} transfer requested  ${tx.hash}`);
    } catch (e) {
      console.log(`  FAIL  VRF sub ${s.subId}: ${e.shortMessage || e.message}`);
    }
  }
  for (const w of leakedSigners.values()) {
    const bal = await provider.getBalance(w.address);
    if (bal <= GAS_RESERVE) { console.log(`  skip  sweep ${short(w.address)}: ${ethers.formatEther(bal)} ETH`); continue; }
    try {
      const tx = await w.sendTransaction({ to: newOwner.address, value: bal - GAS_RESERVE });
      await tx.wait();
      console.log(`  sent  sweep ${ethers.formatEther(bal - GAS_RESERVE)} ETH from ${short(w.address)}  ${tx.hash}`);
    } catch (e) {
      console.log(`  FAIL  sweep ${short(w.address)}: ${e.shortMessage || e.message}`);
    }
  }

  // ── Phase 2 ──
  console.log("\n── Phase 2: the new owner accepts");
  for (const o of owned) {
    const c = new ethers.Contract(o.addr, ABI, newOwner);
    const pending = await tryRead(c, "pendingOwner");
    if (!pending || lc(pending) !== lc(newOwner.address)) continue; // one-step Ownable: already done
    try {
      const tx = await c.acceptOwnership();
      await tx.wait();
      console.log(`  sent  ${short(o.addr)} acceptOwnership  ${tx.hash}`);
    } catch (e) {
      console.log(`  FAIL  ${short(o.addr)} acceptOwnership: ${e.shortMessage || e.message}`);
    }
  }
  for (const s of subPlan) {
    const sc = new ethers.Contract(s.coord, COORD_ABI, newOwner);
    try {
      const tx = await sc.acceptSubscriptionOwnerTransfer(s.subId);
      await tx.wait();
      console.log(`  sent  VRF sub ${s.subId} accepted  ${tx.hash}`);
    } catch (e) {
      console.log(`  FAIL  VRF sub ${s.subId} accept: ${e.shortMessage || e.message}`);
    }
  }

  // ── Read-back ──
  console.log("\n── Read-back");
  let left = 0;
  for (const o of owned) {
    const c = new ethers.Contract(o.addr, ABI, provider);
    const owner = await tryRead(c, "owner");
    const ok = lc(owner) === lc(newOwner.address);
    if (!ok) left++;
    const roles = [];
    for (const r of ROLES) {
      const h = await tryRead(c, r.get);
      if (!h) continue;
      if (leaked.has(lc(h))) left++;
      roles.push(`${r.get}=${short(h)}${leaked.has(lc(h)) ? " LEAKED" : ""}`);
    }
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${o.addr} owner=${short(owner)} ${roles.join(" ")}`);
  }
  for (const s of subPlan) {
    const sub = await tryRead(new ethers.Contract(s.coord, COORD_ABI, provider), "getSubscription", s.subId);
    const ok = sub && lc(sub.subOwner) === lc(newOwner.address);
    if (!ok) left++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  VRF sub ${s.subId} owner=${short(sub?.subOwner)}`);
  }
  for (const st of stuck) { left++; console.log(`  FAIL  ${st}`); }
  console.log(left ? `\n${left} role(s) still with a leaked key — see FAIL / LEAKED above.` : "\nevery role the leaked keys held has moved.");
  process.exit(left ? 1 : 0);
}

main().catch(e => { console.error("failed:", e.shortMessage || e.message); process.exit(1); });
