// analytics.js — live metrics, round history, recent swaps, claims

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
];

const PRIZE_ABI = [
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function currentAccumulatedRewards() external view returns (uint256)",
  "function positionCounter() external view returns (uint256)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "event RoundSettled(uint256 indexed round, bytes6 winningString, uint256 potAmount, uint256 numWinners, uint256 remainderR, uint256 totalEntries, uint256 timestamp)",
  "event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount)"
];

const TIMBS_ABI  = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI    = ["function totalStaked() external view returns (uint256)"];
const VAULT_ABI   = ["function totalLocks() external view returns (uint256)"];
const REGISTRY_ABI = ["function getRoundEntrants(uint256 round) external view returns (address[])"];
const FACTORY_MIN_ABI = ["function getPairAddress(address tokenA, address tokenB) external view returns (address)"];

// TimbYieldVault — ticket capital earns yield for the prize pot.
const YV_ABI = [
  "function previewAccrued() external view returns (uint256)",
  "function reserve() external view returns (uint256)",
  "function totalWeight() external view returns (uint256)",
  "function ratePerSecond1e18() external view returns (uint256)",
  "function lastAccrual() external view returns (uint256)",
  "event Funded(address indexed from, uint256 amount)",
  "event Harvested(uint256 amount, address indexed to)",
  "event WeightRegistered(uint256 indexed ticketId, uint256 weight, uint256 totalWeight)",
  "event WeightRemoved(uint256 indexed ticketId, uint256 weight, uint256 totalWeight)"
];

const BLOCK_RANGE = 50000; // ~7 days on Arb Sepolia

// Read-only queries always go to the canonical Arbitrum Sepolia RPC —
// never the wallet's in-app provider. Mobile wallets sometimes serve
// eth_call/eth_getBalance from a different network than they display,
// which reads as zero balances (or stale state) for perfectly funded
// accounts. The wallet provider is only used for signing transactions.
let _publicProv = null;
function readProv() {
  return _publicProv || (_publicProv = new ethers.providers.JsonRpcProvider(RPC_URL));
}

// ─── Live Metrics ─────────────────────────────────────────────────────────────

async function loadLiveMetrics() {
  const prov = readProv();

  try {
    const pair    = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const timbs   = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, prov);
    const staking = new ethers.Contract(ADDRESSES.TimbStaking, STAKING_ABI, prov);
    const farm    = new ethers.Contract(ADDRESSES.TimbFarm, FARM_ABI, prov);
    const vault   = new ethers.Contract(ADDRESSES.TimbLockVault, VAULT_ABI, prov);
    const prize   = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);

    const registry = new ethers.Contract(ADDRESSES.GameRegistry, REGISTRY_ABI, prov);
    const yvault   = new ethers.Contract(ADDRESSES.TimbYieldVault, YV_ABI, prov);

    const [
      reserves, token0,
      supply, staked, lpStaked, locks,
      round, segment, pot, counter
    ] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      timbs.totalSupply(),
      staking.totalStaked(),
      farm.totalStaked(),
      vault.totalLocks(),
      prize.currentRound(),
      prize.currentSegment(),
      prize.currentAccumulatedRewards(),
      prize.positionCounter()
    ]);

    // Active entries vs earning capital — deliberately two numbers. A
    // replaced ticket's escrow keeps its vault weight through its last
    // eligible round while the pending replacement isn't counted until
    // activation, so tickets and ETH-equivalent weight can diverge.
    const [entrants, earningWeight] = await Promise.all([
      registry.getRoundEntrants(round).catch(() => []),
      yvault.totalWeight().catch(() => null)
    ]);

    // Sort reserves by token direction
    const timbsIsToken0 = token0.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();
    const timbsReserve  = timbsIsToken0 ? reserves.reserve0 : reserves.reserve1;
    const wethReserve   = timbsIsToken0 ? reserves.reserve1 : reserves.reserve0;

    // Price: ETH per TIMBS (how much ETH 1 TIMBS costs)
    const timbsFloat = parseFloat(ethers.utils.formatUnits(timbsReserve, 18));
    const wethFloat  = parseFloat(ethers.utils.formatUnits(wethReserve, 18));
    const priceETH   = timbsFloat > 0 ? (wethFloat / timbsFloat).toFixed(8) : "—";

    // USD anchor: the USDC/WETH pool prices ETH in dollars, and every
    // native pair derives its USD value through it (TIMBS→ETH→USD).
    // No pool yet (or empty) → USD readouts simply don't render.
    let usdPerEth = null;
    try {
      const factory  = new ethers.Contract(ADDRESSES.TimbSwapFactory, FACTORY_MIN_ABI, prov);
      const usdcPair = await factory.getPairAddress(ADDRESSES.USDC, ADDRESSES.WETH);
      if (usdcPair !== ethers.constants.AddressZero) {
        const pc = new ethers.Contract(usdcPair, PAIR_ABI, prov);
        const [ur, ut0] = await Promise.all([pc.getReserves(), pc.token0()]);
        const usdcIs0 = ut0.toLowerCase() === ADDRESSES.USDC.toLowerCase();
        const usdc = parseFloat(ethers.utils.formatUnits(usdcIs0 ? ur.reserve0 : ur.reserve1, 6));
        const weth = parseFloat(ethers.utils.formatUnits(usdcIs0 ? ur.reserve1 : ur.reserve0, 18));
        if (usdc > 0 && weth > 0) usdPerEth = usdc / weth;
      }
    } catch {}
    const usd = (eth) => {
      if (usdPerEth === null) return null;
      const v = eth * usdPerEth;
      if (v === 0) return "0";
      // Sub-cent values (a single TIMBS) keep two significant digits
      // instead of rounding to $0.
      if (v < 0.01) return v.toPrecision(2);
      return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    };

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set("m-price",        priceETH + " ETH");
    const priceUsd = priceETH !== "—" ? usd(parseFloat(priceETH)) : null;
    set("m-price-sub",    priceUsd ? `per TIMBS · ≈ $${priceUsd}` : "per TIMBS");
    set("m-timbs-reserve", fmt(timbsReserve, 18, 0) + " TIMBS");
    set("m-weth-reserve",  fmt(wethReserve, 18, 4)  + " WETH");
    set("m-pot",          fmt(pot, 18, 4) + " ETH");
    const potUsd = usd(parseFloat(ethers.utils.formatUnits(pot, 18)));
    set("m-pot-sub",      `Round ${round} · Seg ${segment}/6` + (potUsd ? ` · ≈ $${potUsd}` : ""));
    set("m-scroll",       counter.toString());
    set("m-staked",       fmt(staked, 18, 0) + " TIMBS");
    set("m-lp-staked",    fmt(lpStaked, 18, 4) + " LP");
    set("m-supply",       fmt(supply, 18, 0) + " TIMBS");
    set("m-locks",        locks.toString());
    set("m-entries",      `${entrants.length} ticket${entrants.length === 1 ? "" : "s"}`);
    if (earningWeight) set("m-entries-sub", `${fmt(earningWeight, 18, 4)} ETH-eq earning yield`);

    DebugHub.logCheckpoint("Analytics:Metrics Loaded", "pass");
  } catch (e) {
    console.warn("loadLiveMetrics:", e.message);
    DebugHub.logError("loadLiveMetrics", e);
  }
}

// ─── Round History ────────────────────────────────────────────────────────────

function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "—";
  const hex = b6.replace("0x", "");
  let s = "";
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

async function loadRoundHistory() {
  const tbody    = document.getElementById("rounds-tbody");
  const statusEl = document.getElementById("rounds-status");
  const prize    = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, readProv());

  try {
    const currentRound = (await prize.currentRound()).toNumber();
    if (currentRound <= 1) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No completed rounds yet</td></tr>';
      statusEl.textContent = "No rounds settled";
      return;
    }

    tbody.innerHTML = "";
    const start = Math.max(1, currentRound - 20);
    let count = 0;

    for (let r = currentRound - 1; r >= start; r--) {
      try {
        const result = await prize.getRoundResult(r);
        if (result.winningString === "0x000000000000") continue;

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>#${r}</td>
          <td class="td-string">${bytes6ToStr(result.winningString)}</td>
          <td>${fmt(result.potAmount, 18, 4)} ETH</td>
          <td>${result.winners.length}</td>
          <td>${fmt(result.remainder, 18, 4)} ETH</td>
          <td>—</td>
        `;
        tbody.appendChild(tr);
        count++;
      } catch {}
    }

    if (count === 0) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No completed rounds yet</td></tr>';
    statusEl.textContent = `${count} rounds`;
    DebugHub.logCheckpoint("Analytics:Rounds Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load round history</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadRoundHistory", e);
  }
}

// ─── Recent Swaps ─────────────────────────────────────────────────────────────

async function loadRecentSwaps() {
  const tbody    = document.getElementById("swaps-tbody");
  const statusEl = document.getElementById("swaps-status");
  const prov     = readProv();

  try {
    const pair       = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const token0Addr = await pair.token0();
    const timbsIs0   = token0Addr.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();

    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);

    const filter = pair.filters.Swap();
    const events = await pair.queryFilter(filter, fromBlock, currentBlock);
    const recent  = events.slice(-50).reverse();

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No swaps in the last 50,000 blocks</td></tr>';
      statusEl.textContent = "0 swaps";
      return;
    }

    tbody.innerHTML = "";
    for (const ev of recent) {
      const { amount0In, amount1In, amount0Out, amount1Out, sender } = ev.args;

      // Determine direction
      const buyingTIMBS = timbsIs0 ? amount0Out.gt(0) : amount1Out.gt(0);
      const amtIn  = timbsIs0
        ? (amount1In.gt(0)  ? fmt(amount1In, 18, 4)  + " WETH"  : fmt(amount0In, 18, 2)  + " TIMBS")
        : (amount0In.gt(0)  ? fmt(amount0In, 18, 4)  + " WETH"  : fmt(amount1In, 18, 2)  + " TIMBS");
      const amtOut = timbsIs0
        ? (amount0Out.gt(0) ? fmt(amount0Out, 18, 2) + " TIMBS" : fmt(amount1Out, 18, 4) + " WETH")
        : (amount1Out.gt(0) ? fmt(amount1Out, 18, 2) + " TIMBS" : fmt(amount0Out, 18, 4) + " WETH");
      const direction = buyingTIMBS ? "Buy TIMBS" : "Sell TIMBS";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ev.blockNumber}</td>
        <td class="td-addr" onclick="window.open('https://sepolia.arbiscan.io/address/${sender}','_blank')">${fmtAddr(sender)}</td>
        <td class="${buyingTIMBS ? 'td-in' : 'td-out'}">${direction}</td>
        <td>${amtIn}</td>
        <td>${amtOut}</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = `${recent.length} swaps`;
    DebugHub.logCheckpoint("Analytics:Swaps Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Could not load swap history</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadRecentSwaps", e);
  }
}

// ─── Claims History ───────────────────────────────────────────────────────────

async function loadClaims() {
  const tbody    = document.getElementById("claims-tbody");
  const statusEl = document.getElementById("claims-status");
  const prov     = readProv();

  try {
    const prize        = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);
    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);

    const filter = prize.filters.WinningsClaimed();
    const events  = await prize.queryFilter(filter, fromBlock, currentBlock);
    const recent  = events.slice(-30).reverse();

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No claims yet</td></tr>';
      statusEl.textContent = "No claims";
      return;
    }

    tbody.innerHTML = "";
    for (const ev of recent) {
      const { winner, round, amount } = ev.args;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>#${round}</td>
        <td class="td-addr" onclick="window.open('https://sepolia.arbiscan.io/address/${winner}','_blank')">${fmtAddr(winner)}</td>
        <td class="td-in">${fmt(amount, 18, 4)} ETH</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = `${recent.length} claims`;
    DebugHub.logCheckpoint("Analytics:Claims Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">Could not load claims</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadClaims", e);
  }
}

// ─── Yield Vault ──────────────────────────────────────────────────────────────
// Public: yield accrued for the pot (metric card) + the money-flow events
// (Funded in, Harvested out to TimbPrize). Wallet-gated: the internals that
// aren't on the dashboard — total weight, yield rate, reserve, last accrual,
// and per-ticket weight registrations.

async function loadVault() {
  const prov  = readProv();
  const vault = new ethers.Contract(ADDRESSES.TimbYieldVault, YV_ABI, prov);
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  // ── Public top-line + activity table ──
  try {
    const [accrued, reserve] = await Promise.all([
      vault.previewAccrued(),
      vault.reserve()
    ]);
    set("m-yield", fmt(accrued, 18, 6) + " ETH");
    set("m-yield-sub", `reserve ${fmt(reserve, 18, 4)} ETH`);
  } catch (e) {
    console.warn("loadVault metrics:", e.message);
  }

  const tbody    = document.getElementById("vault-tbody");
  const statusEl = document.getElementById("vault-status");
  try {
    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);
    const [funded, harvested] = await Promise.all([
      vault.queryFilter(vault.filters.Funded(),    fromBlock, currentBlock),
      vault.queryFilter(vault.filters.Harvested(), fromBlock, currentBlock)
    ]);
    const rows = [
      ...funded.map(ev => ({
        block: ev.blockNumber, type: "Funded", cls: "td-in",
        amount: ev.args.amount, who: ev.args.from
      })),
      ...harvested.map(ev => ({
        block: ev.blockNumber, type: "Harvested → Pot", cls: "td-out",
        amount: ev.args.amount, who: ev.args.to
      }))
    ].sort((a, b) => b.block - a.block).slice(0, 30);

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No vault activity in the last 50,000 blocks</td></tr>';
      statusEl.textContent = "0 events";
    } else {
      tbody.innerHTML = "";
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="${r.cls}">${r.type}</td>
          <td>${fmt(r.amount, 18, 6)} ETH</td>
          <td class="td-addr" onclick="window.open('https://sepolia.arbiscan.io/address/${r.who}','_blank')">${fmtAddr(r.who)}</td>
          <td>${r.block}</td>
        `;
        tbody.appendChild(tr);
      }
      statusEl.textContent = `${rows.length} events`;
    }
    DebugHub.logCheckpoint("Analytics:Vault Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Could not load vault activity</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadVault", e);
  }

  // ── Wallet-gated internals ──
  const note   = document.getElementById("vault-gated-note");
  const detail = document.getElementById("vault-detail");
  if (!userAddress) {
    note?.classList.remove("hidden");
    detail?.classList.add("hidden");
    return;
  }
  note?.classList.add("hidden");
  detail?.classList.remove("hidden");

  try {
    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);
    const [weight, rate, reserve, lastTs, regs, rems] = await Promise.all([
      vault.totalWeight(),
      vault.ratePerSecond1e18(),
      vault.reserve(),
      vault.lastAccrual(),
      vault.queryFilter(vault.filters.WeightRegistered(), fromBlock, currentBlock),
      vault.queryFilter(vault.filters.WeightRemoved(),    fromBlock, currentBlock)
    ]);

    // Daily yield at the current weight: totalWeight × rate/sec × 86400
    const perDay = weight.mul(rate).div(ethers.constants.WeiPerEther).mul(86400);
    set("v-weight",  fmt(weight, 18, 6) + " ETH-eq");
    set("v-rate",    fmt(perDay, 18, 8) + " ETH");
    set("v-reserve", fmt(reserve, 18, 4) + " ETH");
    const ts = lastTs.toNumber();
    set("v-accrual", ts ? new Date(ts * 1000).toLocaleTimeString() : "—");
    set("v-accrual-sub", ts ? new Date(ts * 1000).toLocaleDateString() : "on-chain touch");

    const wTbody = document.getElementById("vault-weights-tbody");
    const wRows = [
      ...regs.map(ev => ({ block: ev.blockNumber, dir: "+ Registered", cls: "td-in",
                           id: ev.args.ticketId, w: ev.args.weight, total: ev.args.totalWeight })),
      ...rems.map(ev => ({ block: ev.blockNumber, dir: "− Removed", cls: "td-out",
                           id: ev.args.ticketId, w: ev.args.weight, total: ev.args.totalWeight }))
    ].sort((a, b) => b.block - a.block).slice(0, 30);

    if (wRows.length === 0) {
      wTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No ticket weight changes in the last 50,000 blocks</td></tr>';
      set("vault-detail-status", "0 changes");
    } else {
      wTbody.innerHTML = "";
      for (const r of wRows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>#${r.id}</td>
          <td class="${r.cls}">${r.dir}</td>
          <td>${fmt(r.w, 18, 6)}</td>
          <td>${fmt(r.total, 18, 6)}</td>
          <td>${r.block}</td>
        `;
        wTbody.appendChild(tr);
      }
      set("vault-detail-status", `${wRows.length} changes`);
    }
  } catch (e) {
    console.warn("loadVault internals:", e.message);
    set("vault-detail-status", "Error");
    DebugHub.logError("loadVault.internals", e);
  }
}

// ─── Metric filter (wallet-gated) ─────────────────────────────────────────────
// Connected wallets get a pill row that slices the live-metrics grid by
// category (data-cat on each card). Disconnecting hides the row and always
// restores the full grid, so visitors never see a partial view.

function setMetricFilter(cat) {
  document.querySelectorAll("#metric-filter .mf-btn").forEach(b =>
    b.classList.toggle("mf-active", b.dataset.cat === cat));
  document.querySelectorAll("#live-metrics-grid .metric-card").forEach(c =>
    c.classList.toggle("hidden", cat !== "all" && c.dataset.cat !== cat));
}

function updateMetricFilterGate() {
  const bar = document.getElementById("metric-filter");
  if (!bar) return;
  const connected = !!userAddress;
  bar.classList.toggle("hidden", !connected);
  // Restore the full grid before re-gating so the filter and the connect
  // gate never fight over a card's hidden state.
  const active = document.querySelector("#metric-filter .mf-active")?.dataset.cat || "all";
  setMetricFilter(connected ? active : "all");
  applyDisconnectGate();
}

// Disconnected visitors keep only the market top-line (price, pool reserves,
// circulating supply — cards marked data-public). Everything else — the
// protocol internals cards and the round/vault/swaps sections — unlocks on
// connect, replaced by a single connect prompt while disconnected.
function applyDisconnectGate() {
  const connected = !!userAddress;
  if (!connected) {
    document.querySelectorAll("#live-metrics-grid .metric-card").forEach(card => {
      if (card.dataset.public !== "1") card.classList.add("hidden");
    });
  }
  document.querySelectorAll("[data-gated]").forEach(el =>
    el.classList.toggle("hidden", !connected));
  document.getElementById("analytics-gate")?.classList.toggle("hidden", connected);
}

// ─── Wallet Connect (minimal — analytics is mostly read-only) ─────────────────

async function handleConnect() {
  const ok = await connectWallet();
  if (!ok) return;
  DebugHub.startSession();
  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  listenForAccountChanges((newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
  });
  loadVault(); // unlock the gated internals
  updateMetricFilterGate();
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  loadVault(); // re-gate the internals
  updateMetricFilterGate();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
    DebugHub.logCheckpoint("Analytics:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _el = document.getElementById("wallet-addr");
    if (_el) _el.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
    updateMetricFilterGate();
  }

  // Apply the connect gate for the current state (reconnect branch already
  // ran it; this covers the plain disconnected load).
  updateMetricFilterGate();

  await Promise.all([
    loadLiveMetrics(),
    loadRoundHistory(),
    loadRecentSwaps(),
    loadClaims(),
    loadVault()
  ]);

  // Refresh live metrics every 15s, events every 60s
  setInterval(loadLiveMetrics, 15000);
  setInterval(() => {
    loadRecentSwaps();
    loadClaims();
    loadVault();
  }, 60000);
})();
