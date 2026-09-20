// vault-to-pot.js — one-off admin: top up the live prize pot with ETH, from
// the deployer wallet (default) or from the TimbYieldVault's free reserve.
//
// TWO SOURCES
// -----------
// SOURCE=wallet: one transaction, prize.addToPot{value: amount}() from the
// signer's own ETH. addToPot is open to anyone; it forwards the ETH into
// PrizeEscrow and bumps currentAccumulatedRewards, which is the only way the
// winnable pot grows outside settlement. This is the default: the deployer
// funds the pot directly.
//
// SOURCE=vault: the vault has no "send reserve to the pot" function. Its only
// outbound path to the prize is harvest(), which is onlyTimbPrize, runs inside
// settlement, and moves only what accrual has already earmarked
// (accruedForPot). The reserve behind that — subsidy ETH not yet earned by any
// ticket — can leave the vault only through the owner's
// emergencyWithdraw(to, amount). So the move is two hops:
//
//   1. vault.emergencyWithdraw(signer, amount)   — owner only
//   2. prize.addToPot{value: amount}()            — anyone
//
// The ETH transits the signer wallet between the two transactions. If step 2
// fails after step 1 confirmed, the ETH is sitting on the signer, not lost:
// re-run with SOURCE=wallet and the same amount to finish the job.
//
// Sending emergencyWithdraw straight to TimbPrize or PrizeEscrow would be a
// mistake: the prize's receive() accepts ETH from the vault but never books it
// (currentAccumulatedRewards stays put, the ETH strands on the prize), and the
// escrow would grow its balance without the winnable pot growing at all.
//
// WHAT IS "FREE" (SOURCE=vault)
// -----------------------------
// reserve() = balance − accruedForPot, but accrual is lazy: pending drip since
// the last touch is not stored until the next register/remove/harvest. That
// pending amount already belongs to the pot, so this tool caps the withdrawal
// at balance − previewAccrued(), never at reserve(). Taking the pending slice
// would show up at the next settlement as yield that failed to harvest.
//
// Draining the reserve does not break anything: accrual pauses when the
// reserve is dry and resumes when it is refunded (vault.fund()). The dry run
// prints the drip runway before and after so the trade-off is visible.
//
// Usage (GitHub Actions "Admin — Fund Pot" workflow, or locally):
//   AMOUNT_ETH=0.001 node scripts/vault-to-pot.js [--dry-run]
//   AMOUNT_ETH=all SOURCE=vault node scripts/vault-to-pot.js [--dry-run]
//   node scripts/vault-to-pot.js --self-test
//
//   AMOUNT_ETH   decimal ETH, or "all" for the whole free vault reserve
//   SOURCE       wallet (default) — addToPot from the signer's own ETH
//                vault            — emergencyWithdraw first, then addToPot
//   --dry-run    print the state and the plan, send nothing
//
// Key: SIGNER_PRIVATE_KEY, falling back to DEPLOYER_PRIVATE_KEY, then
// EPOCH_PRIVATE_KEY. SOURCE=wallet needs no authority: any funded key works,
// and the pot is credited whoever pays. SOURCE=vault must be the vault's
// owner; the script reads owner() and refuses otherwise. Testnet only: the
// deployer key sits in Actions secrets here by decision; on mainnet this runs
// locally from the owner's machine.

const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const SELF_TEST   = process.argv.includes("--self-test");
const DRY_RUN     = process.argv.includes("--dry-run");
const TX_RPC_URL  = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.EPOCH_PRIVATE_KEY;
const AMOUNT_ETH  = (process.env.AMOUNT_ETH ?? "").trim();
const SOURCE      = (process.env.SOURCE ?? "wallet").trim().toLowerCase();

// Gas held back on the signer so the two transactions can always be paid for.
// Arbitrum gas is cheap; this is a ceiling, not an estimate, and the live
// value is refined from getFeeData when the chain is reachable.
const GAS_RESERVE_FALLBACK = ethers.parseEther("0.0003");

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function reserve() view returns (uint256)",
  "function accruedForPot() view returns (uint256)",
  "function previewAccrued() view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function ratePerSecond1e18() view returns (uint256)",
  "function timbPrize() view returns (address)",
  "function emergencyWithdraw(address to, uint256 amount)",
];
const PRIZE_ABI = [
  "function currentAccumulatedRewards() view returns (uint256)",
  "function currentRound() view returns (uint256)",
  "function yieldVault() view returns (address)",
  "function addToPot() payable",
];

const fmt = (wei, d = 6) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtDur = (s) => {
  s = Number(s);
  if (!Number.isFinite(s)) return "∞ (no drip)";
  if (s <= 0) return "0";
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3_600) / 60)}m`;
};

// ─── Pure planning (self-tested) ────────────────────────────────────────────

/** Wei the vault can release without touching what the pot is already owed. */
function freeReserve({ vaultBalance, previewAccrued }) {
  return vaultBalance > previewAccrued ? vaultBalance - previewAccrued : 0n;
}

/** Seconds of drip the reserve funds at the current weight and rate. */
function runwaySeconds({ free, totalWeight, ratePerSecond1e18 }) {
  const perSec = totalWeight * ratePerSecond1e18 / 10n ** 18n;
  if (perSec === 0n) return Infinity;
  return Number(free / perSec);
}

/**
 * Decide the amount and list every reason not to send. Pure: no network.
 *   amountEth   "all" | decimal string
 *   source      "vault" | "wallet"
 *   state       { vaultBalance, previewAccrued, signerBalance, gasReserve,
 *                 vaultOwner, signer }  (wei as bigint, addresses as strings)
 * Returns { amount, free, problems }.
 */
function plan(amountEth, source, state) {
  const problems = [];
  const free = freeReserve(state);
  let amount = 0n;

  if (!["vault", "wallet"].includes(source)) {
    problems.push(`bad SOURCE "${source}" (vault | wallet)`);
    return { amount, free, problems };
  }

  if (amountEth === "all") {
    if (source !== "vault") problems.push(`AMOUNT_ETH=all only makes sense with SOURCE=vault`);
    amount = free;
  } else if (/^\d+(\.\d+)?$/.test(amountEth)) {
    amount = ethers.parseEther(amountEth);
  } else {
    problems.push(`bad AMOUNT_ETH "${amountEth}" (decimal ETH, e.g. 0.001, or "all")`);
    return { amount, free, problems };
  }

  if (amount === 0n) problems.push("nothing to move: amount is 0");

  if (source === "vault") {
    if (state.vaultOwner.toLowerCase() !== state.signer.toLowerCase()) {
      problems.push(`signer is not the vault owner (${state.vaultOwner})`);
    }
    if (amount > free) {
      problems.push(`vault free reserve is ${fmt(free)} ETH < ${fmt(amount)} requested (balance ${fmt(state.vaultBalance)} less ${fmt(state.previewAccrued)} already owed to the pot)`);
    }
    if (state.signerBalance < state.gasReserve) {
      problems.push(`signer holds ${fmt(state.signerBalance)} ETH, below the ${fmt(state.gasReserve)} ETH gas reserve for two transactions`);
    }
  } else if (state.signerBalance < amount + state.gasReserve) {
    problems.push(`signer holds ${fmt(state.signerBalance)} ETH < ${fmt(amount)} + ${fmt(state.gasReserve)} gas reserve`);
  }

  return { amount, free, problems };
}

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = typeof want === "bigint" ? got === want : JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    if (!ok) console.error(`  ✗ ${name}\n      got  ${String(got)}\n      want ${String(want)}`);
  };
  const E = ethers.parseEther;
  const OWNER = "0x000000000000000000000000000000000000AAAA";
  const OTHER = "0x000000000000000000000000000000000000BBBB";
  const base = { vaultBalance: E("0.05"), previewAccrued: E("0.01"), signerBalance: E("0.002"), gasReserve: E("0.0003"), vaultOwner: OWNER, signer: OWNER };
  const probs = (r) => r.problems.length;

  // free reserve never dips below zero, and never counts what the pot is owed
  eq("free = balance − previewAccrued", freeReserve(base), E("0.04"));
  eq("free floors at 0 when owed exceeds balance", freeReserve({ vaultBalance: E("0.01"), previewAccrued: E("0.02") }), 0n);

  // runway
  eq("runway ∞ when no weight", runwaySeconds({ free: E("1"), totalWeight: 0n, ratePerSecond1e18: 5n }), Infinity);
  eq("runway ∞ when rate is 0", runwaySeconds({ free: E("1"), totalWeight: E("1"), ratePerSecond1e18: 0n }), Infinity);
  // weight 1 ETH at 1e12 wei/s per 1e18 weight ⇒ 1e12 wei/s ⇒ 1 ETH lasts 1e6 s
  eq("runway = free ÷ (weight × rate)", runwaySeconds({ free: E("1"), totalWeight: E("1"), ratePerSecond1e18: 10n ** 12n }), 1_000_000);

  // happy paths
  let r = plan("0.01", "vault", base);
  eq("vault: explicit amount accepted", r.amount, E("0.01"));
  eq("vault: no problems", probs(r), 0);
  r = plan("all", "vault", base);
  eq("vault: all = free reserve", r.amount, E("0.04"));
  eq("vault: all has no problems", probs(r), 0);
  r = plan("0.001", "wallet", { ...base, signer: OTHER });
  eq("wallet: needs no authority", probs(r), 0);

  // refusals
  eq("vault: refuses more than free", probs(plan("0.05", "vault", base)), 1);
  eq("vault: refuses exactly reserve() when pending is owed", probs(plan("0.045", "vault", base)), 1);
  eq("vault: refuses a non-owner", probs(plan("0.01", "vault", { ...base, signer: OTHER })), 1);
  eq("vault: refuses when signer cannot pay gas", probs(plan("0.01", "vault", { ...base, signerBalance: E("0.0001") })), 1);
  eq("wallet: refuses when amount + gas exceeds balance", probs(plan("0.002", "wallet", base)), 1);
  eq("wallet: refuses all", plan("all", "wallet", base).problems.some((p) => p.includes("AMOUNT_ETH=all")), true);
  eq("refuses zero", probs(plan("0", "vault", base)), 1);
  eq("refuses garbage amount", probs(plan("lots", "vault", base)), 1);
  eq("refuses bad source", probs(plan("0.01", "treasury", base)), 1);
  eq("garbage amount does not also complain about zero", plan("x", "vault", base).problems.length, 1);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ─── Live ───────────────────────────────────────────────────────────────────

async function main() {
  if (!AMOUNT_ETH) throw new Error("AMOUNT_ETH not set (decimal ETH or \"all\")");
  if (!PRIVATE_KEY) throw new Error("SIGNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY / EPOCH_PRIVATE_KEY not set");

  const vaultAddr  = addrFromConfig("TimbYieldVault");
  const prizeAddr  = addrFromConfig("TimbPrize");
  const escrowAddr = addrFromConfig("PrizeEscrow");

  const readProv = new ethers.JsonRpcProvider(rpcFromConfig());
  const txProv   = new ethers.JsonRpcProvider(TX_RPC_URL || rpcFromConfig());
  const signer   = new ethers.Wallet(PRIVATE_KEY, txProv);
  const vault    = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
  const prize    = new ethers.Contract(prizeAddr, PRIZE_ABI, signer);
  const rVault   = vault.connect(readProv);
  const rPrize   = prize.connect(readProv);

  const snapshot = async () => {
    const [vaultBalance, accrued, previewAccrued, totalWeight, rate, vaultOwner, vaultPrize,
           potRewards, round, prizeVault, escrowBalance, signerBalance] = await Promise.all([
      readProv.getBalance(vaultAddr), rVault.accruedForPot(), rVault.previewAccrued(),
      rVault.totalWeight(), rVault.ratePerSecond1e18(), rVault.owner(), rVault.timbPrize(),
      rPrize.currentAccumulatedRewards(), rPrize.currentRound(), rPrize.yieldVault(),
      readProv.getBalance(escrowAddr), readProv.getBalance(signer.address),
    ]);
    return { vaultBalance, accrued, previewAccrued, totalWeight, rate, vaultOwner, vaultPrize,
             potRewards, round, prizeVault, escrowBalance, signerBalance };
  };

  const print = (s, label) => {
    const free = freeReserve(s);
    console.log(`${label}`);
    console.log(`  vault ${vaultAddr}`);
    console.log(`    balance ${fmt(s.vaultBalance)} ETH · owed to pot ${fmt(s.previewAccrued)} (stored ${fmt(s.accrued)}) · free ${fmt(free)}`);
    console.log(`    weight ${fmt(s.totalWeight, 4)} ETH-eq · rate ${s.rate} wei/s per 1e18 · drip ${fmt(s.totalWeight * s.rate / 10n ** 18n * 86_400n)} ETH/day · runway ${fmtDur(runwaySeconds({ free, totalWeight: s.totalWeight, ratePerSecond1e18: s.rate }))}`);
    console.log(`    owner ${s.vaultOwner}`);
    console.log(`  prize ${prizeAddr}  round #${s.round}`);
    console.log(`    pot (currentAccumulatedRewards) ${fmt(s.potRewards)} ETH · escrow balance ${fmt(s.escrowBalance)} ETH`);
    console.log(`  signer ${signer.address}  ${fmt(s.signerBalance)} ETH`);
  };

  let gasReserve = GAS_RESERVE_FALLBACK;
  try {
    const fee = await txProv.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice;
    if (price) gasReserve = price * 400_000n; // two transactions at 200k each, generous on Arbitrum
  } catch { /* fallback stands */ }

  const before = await snapshot();
  print(before, `fund pot  source=${SOURCE}  amount=${AMOUNT_ETH}${DRY_RUN ? "  (dry run)" : ""}\n\nBefore:`);

  // Wiring sanity: the vault and the prize must point at each other, or the
  // pot we are funding is not the one this vault serves.
  const problems = [];
  if (before.vaultPrize.toLowerCase() !== prizeAddr.toLowerCase()) problems.push(`vault.timbPrize() is ${before.vaultPrize}, not config's TimbPrize`);
  if (before.prizeVault.toLowerCase() !== vaultAddr.toLowerCase()) problems.push(`prize.yieldVault() is ${before.prizeVault}, not config's TimbYieldVault`);

  const p = plan(AMOUNT_ETH, SOURCE, { ...before, gasReserve, signer: signer.address });
  problems.push(...p.problems);

  console.log(`\nPlan: ${SOURCE === "vault" ? `emergencyWithdraw(${fmt(p.amount)} ETH → signer), then ` : ""}addToPot(${fmt(p.amount)} ETH)`);
  if (SOURCE === "vault") {
    const freeAfter = p.free > p.amount ? p.free - p.amount : 0n;
    console.log(`  vault free reserve after: ${fmt(freeAfter)} ETH · runway ${fmtDur(runwaySeconds({ free: freeAfter, totalWeight: before.totalWeight, ratePerSecond1e18: before.rate }))}`);
  }
  console.log(`  pot after: ${fmt(before.potRewards + p.amount)} ETH`);

  if (problems.length) {
    console.error("\nPreflight failed:");
    for (const x of problems) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log("\nPreflight OK.");
  if (DRY_RUN) { console.log("--dry-run: not sending."); return; }
  if (!TX_RPC_URL) console.warn("ARB_SEPOLIA_RPC not set — sending through the public RPC");

  if (SOURCE === "vault") {
    const tx = await vault.emergencyWithdraw(signer.address, p.amount);
    console.log(`\n1/2 emergencyWithdraw sent: ${tx.hash}`);
    const rc = await tx.wait();
    console.log(`    confirmed in block ${rc.blockNumber}`);
  }

  let tx2;
  try {
    tx2 = await prize.addToPot({ value: p.amount });
  } catch (e) {
    if (SOURCE === "vault") {
      console.error(`\n2/2 addToPot FAILED to send. The ${fmt(p.amount)} ETH is on the signer wallet ${signer.address}, not lost.`);
      console.error(`    Finish with: SOURCE=wallet AMOUNT_ETH=${ethers.formatEther(p.amount)} node scripts/vault-to-pot.js`);
    }
    throw e;
  }
  console.log(`\n${SOURCE === "vault" ? "2/2" : "1/1"} addToPot sent: ${tx2.hash}`);
  const rc2 = await tx2.wait();
  console.log(`    confirmed in block ${rc2.blockNumber}`);

  const after = await snapshot();
  print(after, "\nAfter:");
  const potDelta    = after.potRewards - before.potRewards;
  const escrowDelta = after.escrowBalance - before.escrowBalance;
  const ok = potDelta === p.amount && escrowDelta >= p.amount;
  console.log(`\n${ok ? "✓" : "✗"} pot +${fmt(potDelta)} ETH · escrow +${fmt(escrowDelta)} ETH (expected +${fmt(p.amount)})`);
  if (!ok) {
    // A concurrent settlement between the two snapshots can move the pot by
    // its own cut or a payout; say so rather than call a good send bad.
    console.warn("  deltas differ from the amount — a settlement may have landed between the snapshots; check the tx on Arbiscan");
  }
  console.log("The analytics page shows the new pot on its next refresh.");
}

module.exports = { freeReserve, runwaySeconds, plan, main };

if (SELF_TEST) selfTest();
else if (require.main === module) main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
