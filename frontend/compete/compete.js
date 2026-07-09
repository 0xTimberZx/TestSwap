// compete.js — TimbSwap Prize Game v2 (digit-locking mechanic)

const TIMBPRIZE_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement, uint256[6] digitCounters, bool[6] digitLocked)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "function hasClaimed(uint256 round, address winner) external view returns (bool)",
  "function claimWinnings(uint256 round) external",
  "function gameStarted() external view returns (bool)"
];

// GameRegistry v2 — ticket model. Every entry is a Ticket with an id;
// replacement mints a new ticket and the senior one becomes Conceded,
// tethered beneath the replacement via supersedes/supersededBy links.
const TICKET_TUPLE =
  "tuple(uint256 id, address owner, bytes6 string6, uint256 playRound, " +
  "uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, " +
  "uint8 status, uint256 supersedes, uint256 supersededBy, uint256 createdAt)";

const GAME_REGISTRY_ABI = [
  "function currentRound() external view returns (uint256)",
  "function entryCostTIMBS() external view returns (uint256)",
  "function entryCostETH() external view returns (uint256)",
  "function additionalRoundCost(uint256 extraRounds) external view returns (uint256)",
  "function activeTicketOf(address owner) external view returns (uint256)",
  `function getTicketsOf(address owner) external view returns (${TICKET_TUPLE}[] list, uint8[] displayStatuses)`,
  "function submitEntry(bytes6 string6, bool useETH, uint256 extraRounds) external payable",
  "function replaceEntry(bytes6 newString6, uint256 extraRounds) external",
  "function claimRefund(uint256 ticketId) external",
  "function cancelEntry() external",
  "function getRoundEntrants(uint256 round) external view returns (address[])"
];

const YIELD_VAULT_ABI = [
  "function previewAccrued() external view returns (uint256)"
];

const TIMBS_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const ELIGIBLE_REGISTRY_ABI = [
  "function getEligibleTokens() external view returns (address[])"
];

const ERC20_SYMBOL_ABI = ["function symbol() external view returns (string)"];
const ERC20_BAL_ABI    = ["function balanceOf(address account) external view returns (uint256)"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Ticket lifecycle (GameRegistry v2): Cancelled reads as Closed once its
// play round begins (the contract's effectiveStatus handles that).
const STATUS_NAMES = ["Pending", "Active", "Conceded", "Ineligible", "Cancelled", "Closed"];

// ─── State ────────────────────────────────────────────────────────────────────

let selectedToken      = { address: "native", symbol: "ETH", isNative: true };
let eligibleTokens     = [];
let extraRounds        = 0;
let entryCostETH_wei   = null;
let entryCostTIMBS_wei = null;
let currentRoundNum    = null;
let lastDigitCounters  = null;
let activeSegIndex     = -1;   // 0-based index into digitCounters for the live segment
let activeSegCounter   = null; // BigNumber — that segment's current counter
let advanceCount       = 1;    // chosen batch size for the Advance panel
let advanceInSettlement = false; // on-chain settlement window blocks nudges
// True when the wallet already has a Pending/Active entry for the next play
// round. The contract allows only one entry per round, so a second submit
// reverts (UNPREDICTABLE_GAS_LIMIT) — we route to replaceEntry instead.
let hasPlayEntry       = false;

// Read-only queries always go to the canonical Arbitrum Sepolia RPC —
// never the wallet's in-app provider. Mobile wallets sometimes serve
// eth_call/eth_getBalance from a different network than they display,
// which reads as zero balances (or stale state) for perfectly funded
// accounts. The wallet provider is only used for signing transactions.
let _publicProv = null;
function readProv() {
  return _publicProv || (_publicProv = new ethers.providers.JsonRpcProvider(RPC_URL));
}

// Read-only contracts are immutable once bound to the (stable) public provider,
// so cache them by address instead of re-instantiating on every 4s/12s poll.
const _roContracts = {};
function contractRO(address, abi) {
  return _roContracts[address] || (_roContracts[address] = new ethers.Contract(address, abi, readProv()));
}

// The yield read runs on the 4s poll; log a read failure only once per session
// so a persistent RPC hiccup doesn't spam DebugHub every tick.
function _logYieldErrOnce(err) {
  if (window.__yieldReadErrorLogged) return;
  window.__yieldReadErrorLogged = true;
  DebugHub.logError("pollRoundState.previewAccrued", err);
}

// ─── Digit Track Display ──────────────────────────────────────────────────────

// When the wallet is disconnected the whole track is gated: instead of the real
// digits it runs a slow marquee that spells out CONNECT WALLET across the six
// cells, so no game state (locked digits, active segment) is visible to onlookers.
const GATE_PHRASE = "CONNECT·WALLET·"; // · is a dim spacer between the words
let gateTimer  = null;
let gateOffset = 0;

function startGateMask() {
  for (let i = 0; i < 6; i++) {
    const cell = document.getElementById("dc" + i);
    if (cell) { cell.classList.remove("locked", "active", "future", "settling"); cell.classList.add("gate-mask"); }
  }
  if (gateTimer) return;
  const paint = () => {
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById("dchar" + i);
      if (!el) continue;
      const ch = GATE_PHRASE[(gateOffset + i) % GATE_PHRASE.length];
      el.textContent = ch;
      el.style.opacity = ch === "·" ? "0.2" : "0.8";
    }
    gateOffset = (gateOffset + 1) % GATE_PHRASE.length;
  };
  paint();
  gateTimer = setInterval(paint, 320);
}

function stopGateMask() {
  if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
  for (let i = 0; i < 6; i++) {
    document.getElementById("dc" + i)?.classList.remove("gate-mask");
    const el = document.getElementById("dchar" + i);
    if (el) el.style.opacity = "";
  }
}

function renderDigitTrack(segment, digitCounters, digitLocked, inSettlement) {
  // Wallet-gated: hide every real digit behind the CONNECT WALLET marquee.
  if (!userAddress) { startGateMask(); return; }
  stopGateMask();

  for (let i = 0; i < 6; i++) {
    const seg = i + 1;
    const cell    = document.getElementById("dc" + i);
    const charEl  = document.getElementById("dchar" + i);
    if (!cell || !charEl) continue;
    cell.classList.remove("locked", "active", "future", "gated", "settling", "gate-mask");
    if (seg < segment || (seg === segment && digitLocked[i])) {
      charEl.textContent = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      cell.classList.add("locked");
    } else if (seg === segment) {
      charEl.textContent = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      // Keep the current segment marked as active even during settlement so the
      // "current part of the meter" indicator never disappears.
      cell.classList.add("active");
      if (inSettlement) cell.classList.add("settling");
    } else {
      // The meter is continuous — future segments already hold the value
      // carried over from the previous round (round 1 ending ABCJLA leaves
      // J, L, … sitting in their segments). Show it dimmed instead of a
      // blank dot; nudging resumes from here when the segment activates.
      charEl.textContent = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      cell.classList.add("future");
    }
  }
}

// ─── Poll Round State ─────────────────────────────────────────────────────────

// Transition tracking for DebugHub — see _trackRoundTransitions.
let _lastRound        = null;   // last seen round number
let _lastSegment      = null;   // last seen segment number
let _lastInSettlement = null;   // last seen settlement flag
let _settlementSince  = null;   // ms timestamp when the current window began
let _overdueLogged    = false;  // one alarm per window, not one per poll
const SETTLEMENT_OVERDUE_MS = 2 * 60 * 1000; // nominal window is 15s

function _trackRoundTransitions(s) {
  const round        = s.round.toNumber();
  const segment      = s.segment.toNumber();
  const inSettlement = !!s.inSettlement;

  if (_lastRound !== null && round !== _lastRound) {
    DebugHub.logCheckpoint("Prize:Round Rolled", "pass");
  } else if (_lastSegment !== null && segment !== _lastSegment) {
    DebugHub.logCheckpoint("Prize:Segment Advanced", "pass");
  }

  if (_lastInSettlement !== null && inSettlement !== _lastInSettlement) {
    DebugHub.logCheckpoint(
      inSettlement ? "Prize:Settlement Window Entered" : "Prize:Settlement Window Exited",
      "pass"
    );
  }
  if (inSettlement) {
    if (_settlementSince === null) _settlementSince = Date.now();
    if (!_overdueLogged && Date.now() - _settlementSince > SETTLEMENT_OVERDUE_MS) {
      // The settler keeper should land within seconds of the boundary —
      // minutes in this state means the game is stalled and nudges revert.
      DebugHub.logCheckpoint("Prize:Settlement Overdue", "fail");
      _overdueLogged = true;
    }
  } else {
    _settlementSince = null;
    _overdueLogged   = false;
  }

  _lastRound        = round;
  _lastSegment      = segment;
  _lastInSettlement = inSettlement;
}

async function pollRoundState() {
  try {
    const prize   = contractRO(ADDRESSES.TimbPrize, TIMBPRIZE_ABI);
    const started = await prize.gameStarted();

    if (!started) {
      document.getElementById("hdr-round").textContent   = "—";
      document.getElementById("sub-timer").textContent   = "Game not started";
      return;
    }

    const s = await prize.getRoundState();
    currentRoundNum = s.round.toNumber();

    // Game-state transition telemetry. Today's stagnation incident was
    // invisible in the DebugHub export (only sessions + RPC noise), so
    // record round/segment/settlement transitions — fired on CHANGE only,
    // never per 4-second poll — plus an explicit overdue alarm when a
    // settlement window outlives its nominal 15 seconds by 2+ minutes
    // (i.e. the settler keeper isn't landing).
    _trackRoundTransitions(s);

    document.getElementById("hdr-round").textContent      = "#" + s.round.toString();
    document.getElementById("hdr-segment-num").textContent = s.segment.toString();

    // Pot substats as ordered segments: Pot · backed by · yield accruing.
    // "backed by" (escrow reserve) sits right after the pot; yield accruing
    // is its own segment (no longer parenthetical).
    // Each segment glues its own words with non-breaking spaces ( ) so it
    // never breaks mid-value; segments join with regular spaces around " · "
    // so the line wraps only *between* stats on a narrow (mobile) viewport.
    const potSegs = ["Pot: " + fmt(s.pot) + " ETH"];

    // The three secondary reads (escrow backing, accruing yield, round
    // entrants) are independent — fire them together instead of three serial
    // round-trips on every 4s poll. Each resolves to null on read failure.
    const hasVault = ADDRESSES.TimbYieldVault && !/^0x0{40}$/.test(ADDRESSES.TimbYieldVault.replace("0x",""));
    const [escrowBal, accrued, entrants] = await Promise.all([
      ADDRESSES.PrizeEscrow ? readProv().getBalance(ADDRESSES.PrizeEscrow).catch(() => null) : null,
      hasVault ? contractRO(ADDRESSES.TimbYieldVault, YIELD_VAULT_ABI).previewAccrued().catch(e => { _logYieldErrOnce(e); return null; }) : null,
      contractRO(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI).getRoundEntrants(currentRoundNum).catch(() => null),
    ]);

    // Escrow backing — only when it exceeds the accounted (winnable) pot, e.g.
    // a direct seed not registered via fundPot().
    if (escrowBal && escrowBal.gt(s.pot)) potSegs.push(`backed by ${fmt(escrowBal)} ETH`);
    // Live yield accruing from active-ticket escrow (4th pot source).
    if (accrued && !accrued.isZero()) potSegs.push(`yield accruing ${fmt(accrued)} ETH`);
    document.getElementById("sub-pot").textContent = potSegs.join(" · ");

    // Entries playing THIS round — was a dead "— entries" placeholder.
    if (entrants) {
      document.getElementById("sub-entries").textContent =
        `${entrants.length} ${entrants.length === 1 ? "entry" : "entries"}`;
    }

    const timerEl = document.getElementById("sub-timer");
    if (s.inSettlement) {
      timerEl.textContent = "Intermission — calculating…";
    } else {
      const elapsed    = Math.floor(Date.now() / 1000) - s.segmentStart.toNumber();
      const remaining  = Math.max(0, (59 * 60 + 45) - elapsed);
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      timerEl.textContent = `${mm}:${ss} left in segment`;
    }

    // Flash active digit on counter change
    if (lastDigitCounters) {
      const seg = s.segment.toNumber() - 1;
      if (s.digitCounters[seg].toString() !== lastDigitCounters[seg]) {
        const cell = document.getElementById("dc" + seg);
        if (cell) {
          cell.style.transform = "scale(1.15)";
          setTimeout(() => { cell.style.transform = ""; }, 300);
        }
      }
    }
    lastDigitCounters = s.digitCounters.map(d => d.toString());

    renderDigitTrack(
      s.segment.toNumber(),
      s.digitCounters,
      s.digitLocked,
      s.inSettlement
    );

    // Show/hide gated notice
    const notice = document.getElementById("gated-notice");
    if (notice) notice.classList.toggle("hidden", !!userAddress);

    // Advance panel: wallet-gated, disabled during settlement; preview needs
    // the active segment's current digit.
    activeSegIndex   = s.segment.toNumber() - 1;
    activeSegCounter = s.digitCounters[activeSegIndex];

    // Remaining free (gas-only) nudges for this wallet this segment. Silent
    // on failure (old router without the view, or RPC hiccup) → treat as
    // unknown so the panel falls back to the plain per-tx cap.
    if (userAddress && ADDRESSES.TimbSwapRouter) {
      try {
        const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_NUDGE_ABI, readProv());
        freeNudgesLeft = (await router.freeNudgesRemaining(userAddress)).toNumber();
        if (advanceCount > advanceCeiling()) setAdvanceCount(advanceCeiling());
      } catch { freeNudgesLeft = null; }
    } else {
      freeNudgesLeft = null;
    }

    updateAdvancePanel(!!s.inSettlement);

  } catch (e) {
    // Public-RPC hiccups (a dropped eth_call response) surface as
    // CALL_EXCEPTION "missing revert data" with an inner SERVER_ERROR —
    // nothing reverted on-chain. Skip the tick quietly; the next poll is
    // 4 seconds away. Only report to DebugHub once several polls in a row
    // fail, which means the endpoint is actually down rather than flaky.
    if (isTransientRpcError(e)) {
      pollFailStreak++;
      console.warn(`pollRoundState: transient RPC error (${pollFailStreak} in a row) — ${e.message}`);
      if (pollFailStreak === POLL_FAIL_ALERT_AT) {
        DebugHub.logError("pollRoundState.rpcDown",
          new Error(`${POLL_FAIL_ALERT_AT} consecutive RPC failures — endpoint may be down`));
      }
      return;
    }
    console.warn("pollRoundState:", e.message);
    DebugHub.logError("pollRoundState", e);
    return;
  }
  pollFailStreak = 0;
}

// ─── Transient RPC detection ─────────────────────────────────────────────────

let pollFailStreak = 0;
const POLL_FAIL_ALERT_AT = 3;

function isTransientRpcError(e) {
  if (!e) return false;
  if (e.code === "SERVER_ERROR" || e.code === "TIMEOUT" || e.code === "NETWORK_ERROR") return true;
  const inner = e.error || {};
  const text  = `${e.message || ""} ${inner.message || ""} ${inner.reason || ""} ${inner.code || ""}`;
  return e.code === "CALL_EXCEPTION" &&
         /missing response|missing revert data|SERVER_ERROR|bad response|timeout/i.test(text);
}

// ─── Entry Costs ─────────────────────────────────────────────────────────────

async function loadEntryCosts() {
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    [entryCostETH_wei, entryCostTIMBS_wei] = await Promise.all([
      registry.entryCostETH(),
      registry.entryCostTIMBS()
    ]);
    updateCostDisplay();
  } catch (e) { console.warn("loadEntryCosts:", e.message); }
}

async function updateCostDisplay() {
  if (!entryCostETH_wei) return;
  const el = document.getElementById("entry-cost-val");

  let base = selectedToken.isNative
    ? fmt(entryCostETH_wei) + " ETH"
    : fmtTIMBS(entryCostTIMBS_wei);

  el.textContent = base;

  const noteEl = document.getElementById("extra-cost-note");
  if (extraRounds > 0 && noteEl) {
    try {
      const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
      const extra = await registry.additionalRoundCost(extraRounds);
      noteEl.textContent = `+ ${fmtTIMBS(extra)} · non-refundable`;
      noteEl.classList.remove("hidden");
    } catch { noteEl.classList.add("hidden"); }
  } else if (noteEl) {
    noteEl.classList.add("hidden");
  }
}

// ─── Token Dropdown ───────────────────────────────────────────────────────────

async function buildTokenDropdown() {
  try {
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_REGISTRY_ABI, readProv());
    const addrs    = await registry.getEligibleTokens();

    eligibleTokens = [{ address: "native", symbol: "ETH", isNative: true }];

    // Read every eligible token's symbol in parallel instead of blocking on
    // each round-trip; preserve registry order and drop any that fail.
    const wanted = addrs.filter(a => {
      const lc = a.toLowerCase();
      return lc !== ADDRESSES.WETH.toLowerCase() && lc !== ADDRESSES.DAPP.toLowerCase();
    });
    const resolved = await Promise.all(wanted.map(async addr => {
      try {
        const symbol = await new ethers.Contract(addr, ERC20_SYMBOL_ABI, readProv()).symbol();
        return { address: addr, symbol, isNative: false };
      } catch { return null; }
    }));
    for (const t of resolved) if (t) eligibleTokens.push(t);
    renderTokenDropdown();
  } catch {
    eligibleTokens = [
      { address: "native", symbol: "ETH", isNative: true },
      { address: ADDRESSES.TIMBSToken, symbol: "TIMBS", isNative: false }
    ];
    renderTokenDropdown();
  }
}

function renderTokenDropdown() {
  const dropdown = document.getElementById("token-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";
  eligibleTokens.forEach(t => {
    const item = document.createElement("div");
    item.className = "token-drop-item" + (t.symbol === selectedToken.symbol ? " selected" : "");
    item.textContent = t.symbol;
    item.onclick = () => selectEntryToken(t);
    dropdown.appendChild(item);
  });
}

function selectEntryToken(token) {
  selectedToken = token;
  document.getElementById("selected-token-label").textContent = token.symbol;
  document.getElementById("token-dropdown").classList.add("hidden");
  renderTokenDropdown();
  updateCostDisplay();
  refreshEntryBalance();
}

// Discrete balance of the currently-selected eligible entry token. Entry
// tokens are ETH/TIMBS (18 decimals); the read is wallet-gated and silent
// when disconnected. Extra rounds always cost TIMBS regardless of the base
// token, so when extra rounds are selected we also surface the TIMBS balance.
async function refreshEntryBalance() {
  const el = document.getElementById("entry-token-bal");
  if (!el) return;
  if (!userAddress) { el.textContent = ""; return; }
  try {
    const bal = selectedToken.isNative
      ? await readProv().getBalance(userAddress)
      : await new ethers.Contract(selectedToken.address, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
    let txt = `Balance: ${fmt(bal, 18, 4)} ${selectedToken.symbol}`;
    if (extraRounds > 0 && selectedToken.isNative) {
      const timbs = await new ethers.Contract(ADDRESSES.TIMBSToken, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
      txt += ` · ${fmt(timbs, 18, 2)} TIMBS`;
    }
    el.textContent = txt;
  } catch {
    // Transient RPC read failure — keep whatever balance was last shown rather
    // than blanking the line, so the readout is consistently present. It'll
    // self-correct on the next refresh (poll, token switch, stepper).
  }
}

function toggleTokenDropdown() {
  if (eligibleTokens.length <= 2) {
    const idx  = eligibleTokens.findIndex(t => t.symbol === selectedToken.symbol);
    const next = eligibleTokens[(idx + 1) % eligibleTokens.length];
    selectEntryToken(next);
    return;
  }
  document.getElementById("token-dropdown").classList.toggle("hidden");
}

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("token-select-btn")?.closest(".token-select-wrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("token-dropdown")?.classList.add("hidden");
  }
});

// ─── Extra Rounds ─────────────────────────────────────────────────────────────

// Contract caps extra rounds at MAX_EXTRA_ROUNDS (GameRegistry). The
// stepper must respect it — an out-of-range value reverts every entry
// with TooManyExtraRounds (observed live: user reached 15, cap is 12).
const MAX_EXTRA_ROUNDS = 12;
function adjustExtraRounds(delta) {
  extraRounds = Math.min(MAX_EXTRA_ROUNDS, Math.max(0, extraRounds + delta));
  document.getElementById("extra-rounds-val").textContent = extraRounds;
  refreshEntryBalance();
  updateCostDisplay();
}

// ─── Entry Validation ─────────────────────────────────────────────────────────

function onEntryInput() {
  const input = document.getElementById("entry-string");
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const val   = input.value;
  const vEl   = document.getElementById("entry-validation");

  if (!val) {
    vEl.textContent = ""; vEl.className = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton(); return;
  }

  if (val.length < 6) {
    vEl.textContent = `${6 - val.length} more needed`;
    vEl.className   = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton(); return;
  }

  const seen = new Set();
  let hasRepeat = false;
  for (const c of val) { if (seen.has(c)) { hasRepeat = true; break; } seen.add(c); }

  if (hasRepeat) {
    vEl.textContent = "No repeating characters";
    vEl.className   = "entry-validation error";
    input.classList.add("invalid"); input.classList.remove("valid");
  } else {
    vEl.textContent = "Valid entry ✓";
    vEl.className   = "entry-validation ok";
    input.classList.add("valid"); input.classList.remove("invalid");
  }
  updateEntryButton();
}

function isEntryValid() {
  const val = document.getElementById("entry-string").value;
  if (val.length !== 6) return false;
  const seen = new Set();
  for (const c of val) { if (seen.has(c)) return false; seen.add(c); }
  return true;
}

function updateEntryButton() {
  const btn = document.getElementById("entry-btn");
  if (!userAddress) { btn.textContent = "Connect wallet to enter"; btn.disabled = true; return; }
  if (!isEntryValid()) { btn.textContent = "Enter a valid 6-character string"; btn.disabled = true; return; }
  // Only one entry per round — if we already have one queued, this replaces it.
  btn.textContent = hasPlayEntry ? "Update entry" : "Submit Entry";
  btn.disabled    = false;
}

// ─── Submit Entry ─────────────────────────────────────────────────────────────

function stringToBytes6(str) {
  let hex = "0x";
  for (let i = 0; i < 6; i++) hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

// ─── Replace warning (entries don't stack) ────────────────────────────────
// Players mid-game submitting again may expect a SECOND stacked entry.
// One live ticket per wallet: a new submit concedes the old ticket. Warn
// once (dismissable forever via "don't show again"); "I understand"
// proceeds, tapping outside cancels the submit.

const REPLACE_WARN_KEY = "timbswap_replace_warn_off";
let _replaceWarnResolve = null;

function showReplaceWarning() {
  try { if (localStorage.getItem(REPLACE_WARN_KEY) === "1") return Promise.resolve(true); } catch {}
  const overlay = document.getElementById("replace-warn-overlay");
  if (!overlay) return Promise.resolve(true);
  overlay.classList.remove("hidden");
  return new Promise((resolve) => { _replaceWarnResolve = resolve; });
}

function _closeReplaceWarning(confirmed) {
  const overlay = document.getElementById("replace-warn-overlay");
  if (overlay) overlay.classList.add("hidden");
  if (confirmed && document.getElementById("replace-warn-dontshow")?.checked) {
    try { localStorage.setItem(REPLACE_WARN_KEY, "1"); } catch {}
  }
  if (_replaceWarnResolve) { _replaceWarnResolve(confirmed); _replaceWarnResolve = null; }
}

function confirmReplaceWarning() { _closeReplaceWarning(true); }
function dismissReplaceWarning(e) {
  // Backdrop taps only — clicks inside the card stopPropagation.
  if (e && e.target !== e.currentTarget) return;
  _closeReplaceWarning(false);
}

async function handleSubmitEntry() {
  if (!userAddress || !isEntryValid()) return;
  const btn      = document.getElementById("entry-btn");
  const entryStr = document.getElementById("entry-string").value;
  const string6  = stringToBytes6(entryStr);

  const replacing = hasPlayEntry;
  const resetLabel = replacing ? "Update entry" : "Submit Entry";

  if (replacing) {
    const proceed = await showReplaceWarning();
    if (!proceed) return; // tapped outside — nothing sent
  }

  try {
    btn.disabled = true;
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const useETH   = selectedToken.isNative;

    // When replacing an existing entry, the original principal stays in escrow
    // and is reused — only additional-round TIMBS (if any) is pulled. A fresh
    // entry needs the initial deposit (ETH value, or TIMBS entry cost).
    let timbsNeeded = ethers.BigNumber.from(0);
    if (!replacing && !useETH) timbsNeeded = timbsNeeded.add(entryCostTIMBS_wei);
    if (extraRounds > 0) {
      const extra = await registry.additionalRoundCost(extraRounds);
      timbsNeeded = timbsNeeded.add(extra);
    }

    // Pre-flight: state the shortfall instead of an opaque revert. Extra
    // rounds cost entryCostTIMBS each; this is what caps "how many rounds
    // can I afford" (observed: 4 rounds succeeded, 5+ reverted with the
    // reason stripped by the wallet — it was insufficient TIMBS).
    if (timbsNeeded.gt(0)) {
      const balNow = await new ethers.Contract(ADDRESSES.TIMBSToken, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
      if (balNow.lt(timbsNeeded)) {
        const roundsAffordable = entryCostTIMBS_wei && !entryCostTIMBS_wei.isZero()
          ? balNow.div(entryCostTIMBS_wei).toString() : "?";
        alert(
          `Not enough TIMBS for this entry.\nNeeds ${fmtTIMBS(timbsNeeded)} ` +
          `(${extraRounds} extra round${extraRounds === 1 ? "" : "s"}` +
          `${!replacing && !useETH ? " + entry" : ""}), you have ${fmtTIMBS(balNow)}. ` +
          `At the current cost you can afford about ${roundsAffordable} extra round(s). ` +
          `Lower the extra-rounds count or top up TIMBS.`
        );
        btn.disabled = false; btn.textContent = resetLabel;
        return;
      }
    }

    if (timbsNeeded.gt(0)) {
      const timbs = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, signer);
      const allow = await timbs.allowance(userAddress, ADDRESSES.GameRegistry);
      if (allow.lt(timbsNeeded)) {
        btn.textContent = "Approving TIMBS…";
        DebugHub.logCheckpoint("Prize:Approve Requested", "pass");
        const gas = await getGasParams(); const nonce = await getPendingNonce();
        await confirmTx(await timbs.approve(ADDRESSES.GameRegistry, ethers.constants.MaxUint256, { ...gas, nonce }));
        DebugHub.logCheckpoint("Prize:Approve Confirmed", "pass");
      }
    }

    btn.textContent = replacing ? "Updating…" : "Submitting…";
    DebugHub.logCheckpoint("Prize:Entry Requested", "pass");
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    let tx;
    if (replacing) {
      // replaceEntry concedes the senior ticket and mints a replacement —
      // the principal carries over, so no ETH value (non-payable in v2).
      tx = await registry.replaceEntry(string6, extraRounds, { ...gas, nonce });
    } else {
      const value = useETH ? entryCostETH_wei : ethers.BigNumber.from(0);
      tx = await registry.submitEntry(string6, useETH, extraRounds, { ...gas, nonce, value });
    }
    DebugHub.logCheckpoint("Prize:Entry Submitted", "pass");
    await confirmTx(tx);
    DebugHub.logCheckpoint("Prize:Entry Confirmed", "pass");

    btn.textContent = replacing ? "Entry updated ✓" : "Entry submitted ✓";
    document.getElementById("entry-string").value = "";
    extraRounds = 0;
    document.getElementById("extra-rounds-val").textContent = "0";
    await loadMyEntries();
    setTimeout(() => { updateEntryButton(); }, 2000);

  } catch (err) {
    console.error("Entry failed:", err.message);
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleSubmitEntry.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleSubmitEntry", err);
    DebugHub.logCheckpoint("Prize:Entry Failed", "fail");
    if (ENTRY_REVERTS[sel]) alert(ENTRY_REVERTS[sel]);
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = resetLabel; btn.disabled = false; }, 2500);
  }
}

// ─── My Entries ───────────────────────────────────────────────────────────────

function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "——";
  const hex = b6.replace("0x", "");
  let s = "";
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

// Renders one ticket card. Conceded ancestors render tethered beneath their
// replacement, dimmed, so the chain aiming for victory stays readable.
function renderTicketRow(t, displayStatus, opts) {
  const statusName  = STATUS_NAMES[displayStatus] || "Unknown";
  const statusClass = "status-" + statusName.toLowerCase();
  const isETH       = t.escrowToken === "0x0000000000000000000000000000000000000000";
  const principal   = t.escrowAmount.isZero()
    ? ""
    : ` · ${isETH ? fmtETH(t.escrowAmount) : fmtTIMBS(t.escrowAmount)}`;
  const playRound = t.playRound.toNumber();
  const lastRound = t.lastEligibleRound.toNumber();
  const roundsTxt = playRound === lastRound ? `R${playRound}` : `R${playRound}–R${lastRound}`;

  // Raw status drives the action buttons; display status drives the badge.
  const raw = t.status;
  const canCancel = raw === 0 && currentRoundNum !== null && playRound > currentRoundNum;
  const expired   = currentRoundNum !== null && currentRoundNum > lastRound;
  const inWindow  = currentRoundNum !== null && currentRoundNum <= lastRound + 2;
  const canRefund = (raw === 0 || raw === 1) && expired && inWindow && !t.escrowAmount.isZero();

  let hint = "";
  if (canCancel)                       hint = ` · withdrawable until R${playRound} starts`;
  else if (raw === 1 && !expired)      hint = ` · earning yield for the pool`;
  else if (canRefund)                  hint = ` · principal refundable now`;
  else if ((raw === 0 || raw === 1) && expired && !inWindow) hint = ` · refund window closed`;

  const row = document.createElement("div");
  row.className = "entry-row-item" + (opts.tethered ? " ticket-conceded" : "");
  row.innerHTML = `
    <div>
      <div class="entry-row-string">${opts.tethered ? '<span class="tether-mark">⤷</span> ' : ""}${bytes6ToStr(t.string6)}</div>
      <div class="entry-row-meta">Ticket #${t.id} · plays ${roundsTxt}${principal}${hint}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="entry-status-badge ${statusClass}">${statusName}</span>
      ${canRefund ? `<button class="btn-claim-mini" onclick="handleClaimRefund(${t.id})">Refund principal</button>` : ""}
      ${canCancel ? `<button class="btn-claim-mini" onclick="handleCancelEntry()">Withdraw</button>` : ""}
    </div>`;
  return row;
}

async function loadMyEntries() {
  const list = document.getElementById("my-entries-list");
  hasPlayEntry = false;
  if (!userAddress) {
    list.innerHTML = '<div class="empty-state">Connect wallet to view entries</div>';
    updateEntryButton();
    return;
  }
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    // Anchor for the relevance filter. currentRoundNum is set by pollRoundState,
    // but init/connect run these in parallel, so it can still be null here —
    // fall back to the registry's own round so old closed tickets are hidden
    // instead of the filter short-circuiting and showing everything.
    let relRound = currentRoundNum;
    const [res, roundFallback] = await Promise.all([
      registry.getTicketsOf(userAddress),
      relRound === null ? registry.currentRound().catch(() => null) : Promise.resolve(null)
    ]);
    if (relRound === null && roundFallback !== null) relRound = roundFallback.toNumber();
    const ticketList = res.list ?? res[0];
    const displays   = res.displayStatuses ?? res[1];
    DebugHub.logCheckpoint("Compete:Tickets Loaded", "pass");
    if (!ticketList.length) {
      list.innerHTML = '<div class="empty-state">No tickets yet</div>';
      updateEntryButton();
      return;
    }

    // Index by id; find chain heads (not superseded by anything).
    const byId = new Map();
    const displayById = new Map();
    ticketList.forEach((t, i) => {
      byId.set(t.id.toString(), t);
      displayById.set(t.id.toString(), displays[i]);
    });

    // One eligible live ticket per wallet — determines Submit vs Update.
    hasPlayEntry = ticketList.some(t =>
      t.status === 0 ||
      (t.status === 1 && relRound !== null && relRound <= t.lastEligibleRound.toNumber())
    );

    // Hide history clutter: once a ticket is more than the refund window
    // (2 rounds) past its last eligible round it can't be played or refunded,
    // so drop those heads. Live/pending and still-refundable tickets stay.
    const withinRelevance = (t) => {
      if (relRound === null) return true;
      return relRound <= t.lastEligibleRound.toNumber() + 2;
    };

    const heads = ticketList
      .filter(t => t.supersededBy.isZero() && withinRelevance(t))
      .sort((a, b) => b.id.toNumber() - a.id.toNumber())
      .slice(0, 8);

    if (!heads.length) {
      list.innerHTML = '<div class="empty-state">No active tickets</div>';
      updateEntryButton();
      return;
    }

    list.innerHTML = "";
    for (const head of heads) {
      list.appendChild(renderTicketRow(head, displayById.get(head.id.toString()), { tethered: false }));
      // Walk conceded ancestry, newest first, tethered beneath the head.
      let cursor = head.supersedes;
      let depth  = 0;
      while (!cursor.isZero() && depth < 8) {
        const anc = byId.get(cursor.toString());
        if (!anc) break;
        list.appendChild(renderTicketRow(anc, displayById.get(anc.id.toString()), { tethered: true }));
        cursor = anc.supersedes;
        depth++;
      }
    }
    updateEntryButton();
  } catch (e) {
    console.warn("loadMyEntries:", e.message);
    DebugHub.logError("loadMyEntries", e);
    DebugHub.logCheckpoint("Compete:Tickets Loaded", "fail");
    list.innerHTML = '<div class="empty-state">Could not load tickets</div>';
  }
}

async function handleClaimRefund(ticketId) {
  try {
    DebugHub.logCheckpoint("Prize:Refund Requested", "pass");
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await registry.claimRefund(ticketId, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Refund Confirmed", "pass");
    await loadMyEntries();
  } catch (err) {
    DebugHub.logError("handleClaimRefund", err);
    DebugHub.logCheckpoint("Prize:Refund Failed", "fail");
    alert("Refund failed: " + (err?.reason || err.message));
  }
}

// ─── Advance Panel (user nudge / batch nudge via router) ──────────────────────
// advanceScroll(count) on the router: count=1 is a single nudge, up to
// MAX_BATCH_NUDGE (20 on-chain) applies that many nudges in one transaction,
// one at a time, in order. The panel's chips/stepper just choose `count`.

const ROUTER_NUDGE_ABI = [
  "function advanceScroll(uint256 count) external",
  "function freeNudgesRemaining(address user) external view returns (uint256)"
];
const ADVANCE_MAX = 20; // mirrors TimbSwapRouter.MAX_BATCH_NUDGE

// Free (gas-only) advanceScroll nudges left for this wallet THIS segment.
// null = not yet known; the router caps the free path per address per segment
// (paid swap-nudges are uncapped). Refreshed each poll and after an advance.
let freeNudgesLeft = null;

function advanceCeiling() {
  // Chosen batch can't exceed the on-chain per-tx cap nor the wallet's
  // remaining free allowance this segment.
  return freeNudgesLeft === null ? ADVANCE_MAX : Math.min(ADVANCE_MAX, freeNudgesLeft);
}

function setAdvanceCount(n) {
  advanceCount = Math.max(1, Math.min(advanceCeiling(), n));
  renderAdvancePreview();
}

// "Max" chip — advance by exactly the remaining free allowance this segment
// (or the per-tx cap when that's unknown). Keeps the label honest as the cap
// is spent or retuned, instead of a fixed "+20" that the 10/segment cap
// silently clamped.
function setAdvanceMax() {
  setAdvanceCount(advanceCeiling());
}
function adjustAdvanceCount(delta) {
  setAdvanceCount(advanceCount + delta);
}

function renderAdvancePreview() {
  const chipsWrap = document.getElementById("advance-chips");
  if (chipsWrap) {
    const ceil = advanceCeiling();
    chipsWrap.querySelectorAll(".adv-chip").forEach(c => {
      if (c.id === "adv-chip-max") {
        // Show the live cap once we know it; plain "Max" when unknown.
        c.textContent = (freeNudgesLeft !== null) ? `Max (${ceil})` : "Max";
        c.classList.toggle("active", ceil > 0 && advanceCount === ceil);
        c.disabled = ceil === 0;
      } else {
        const n = Number(c.dataset.n);
        c.classList.toggle("active", n === advanceCount);
        // Grey out fixed amounts you can't afford within the free cap.
        c.disabled = (freeNudgesLeft !== null && n > ceil);
      }
    });
  }
  const countEl = document.getElementById("advance-count-val");
  if (countEl) countEl.textContent = advanceCount;

  const submitBtn = document.getElementById("advance-submit-btn");
  if (submitBtn) {
    // Game semantics: the 59:45–60:00 intermission belongs to calculations.
    // USER nudges are deactivated during it. The button holds disabled for
    // the first 6 seconds ("calculating") to give the keeper/lazy settle
    // its moment, then re-arms as a direct permissionless settleSegment()
    // push — any player can start the next segment instead of waiting on
    // the keeper cron.
    if (advanceInSettlement) {
      const holding = Date.now() - settlementSeenAt < SETTLE_BTN_HOLD_MS;
      submitBtn.textContent = holding
        ? "Intermission — calculating…"
        : "Settle & start next segment";
      submitBtn.disabled = holding;
    } else if (freeNudgesLeft === 0) {
      // Free (gas-only) allowance spent this segment — the paid path (a swap)
      // still moves the meter, and it's worth more per action.
      submitBtn.textContent = "Free nudges used — swap to move the meter";
      submitBtn.disabled = true;
    } else {
      submitBtn.textContent = (freeNudgesLeft !== null && freeNudgesLeft <= 5)
        ? `Advance ×${advanceCount} · ${freeNudgesLeft} free left`
        : `Advance ×${advanceCount}`;
      submitBtn.disabled = false;
    }
  }

  const previewEl = document.getElementById("advance-preview");
  const fromEl = previewEl?.querySelector(".ap-from");
  const toEl   = previewEl?.querySelector(".ap-to");
  if (!previewEl || !fromEl || !toEl) return;

  if (activeSegIndex < 0 || !activeSegCounter || !userAddress) {
    previewEl.firstChild.textContent = "SEG — · ";
    fromEl.textContent = "·"; toEl.textContent = "·";
    return;
  }
  const from = Number(activeSegCounter) % 36;
  const to   = (from + advanceCount) % 36;
  previewEl.firstChild.textContent = `SEG ${activeSegIndex + 1} · `;
  fromEl.textContent = ALPHABET[from];
  toEl.textContent   = ALPHABET[to];
}

// The settle push holds back for the intermission's first 6 seconds —
// the calculation moment — then the button re-enables itself to push
// into the next segment (see renderAdvancePreview).
let settlementSeenAt = 0;
const SETTLE_BTN_HOLD_MS = 6000;

function updateAdvancePanel(inSettlement) {
  const wasInSettlement = advanceInSettlement;
  advanceInSettlement = !!inSettlement;
  if (advanceInSettlement && !wasInSettlement) {
    settlementSeenAt = Date.now();
    // Re-render right at the 6s mark so the button re-arms itself
    // without waiting for the next 4s poll tick.
    setTimeout(renderAdvancePreview, SETTLE_BTN_HOLD_MS + 100);
  }
  const panel = document.getElementById("advance-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !userAddress);
  const submitBtn = document.getElementById("advance-submit-btn");
  if (submitBtn && !advanceInSettlement) submitBtn.disabled = false;
  renderAdvancePreview();
}

// Wallets often mask estimation reverts as opaque -32603 errors. Decode the
// custom-error selector so a mis-wired deployment names its own fix.
// GameRegistry submitEntry/replaceEntry custom errors → human messages.
const ENTRY_REVERTS = {
  "0x4cbc5815": "Too many extra rounds — the maximum is 12. Lower the extra-rounds count and try again.", // TooManyExtraRounds(uint256,uint256)
  "0xe450d38c": "Not enough TIMBS for this entry (extra rounds cost TIMBS). Reduce extra rounds or top up TIMBS.", // ERC20InsufficientBalance
  "0xfb8f41b2": "TIMBS spending isn't approved for the full amount — approve, then retry.",                 // ERC20InsufficientAllowance
};

const ADVANCE_REVERTS = {
  "0x38a1d6d8": "Router doesn't know the prize contract — call setTimbPrize(<TimbPrize>) on TimbSwapRouter (owner).",   // PrizeNotSet()
  "0x91655201": "TimbPrize doesn't recognize this router — call setRouter(<TimbSwapRouter>) on TimbPrize (owner).",     // NotRouter()
  "0x3a5f7b57": "The game hasn't been started — call startGame() on TimbPrize (owner).",                                // GameNotStarted()
  "0x717824fb": "Settlement is paused — nudges stay blocked until unpauseSettlement().",                                // InSettlementWindow()
  "0x57b4f0b1": "You've used all your free nudges for this segment. Swap an eligible token to keep moving the meter, or wait for the next segment.", // FreeNudgeCapReached(uint256,uint256)
  "0xf451af97": "Nudge count out of range — pick a smaller batch (max 20 per transaction).",                            // InvalidNudgeCount(uint256,uint256)
};

function advanceRevertSelector(err) {
  const d = err?.data?.originalError?.data ?? err?.error?.data?.data ??
            err?.error?.data ?? err?.data;
  const hex = typeof d === "string" ? d
    : (typeof d?.data === "string" ? d.data : null);
  if (hex && hex.startsWith("0x") && hex.length >= 10) return hex.slice(0, 10).toLowerCase();
  // Structured fields only — message-text matching false-positived on
  // addresses and fee values in production.
  return null;
}

// During the settlement window the Advance button routes here instead:
// settleSegment() is permissionless on TimbPrize v3.1, so any connected
// player can land the settle and start the next segment. If the keeper
// (or another player) wins the race, the estimate reverts — re-poll and
// report "already settled" instead of an error.
const PRIZE_SETTLE_ABI = ["function settleSegment() external"];

async function handleSettleNow() {
  const btn = document.getElementById("advance-submit-btn");
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Settling…"; }
    DebugHub.logCheckpoint("Prize:Settle Requested", "pass");
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_SETTLE_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await prize.settleSegment({ ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Settle Confirmed", "pass");
    if (btn) btn.textContent = "Settled ✓ — next segment live";
    await pollRoundState();
    setTimeout(() => { if (btn) { btn.disabled = false; renderAdvancePreview(); } }, 1500);
  } catch (err) {
    await pollRoundState();
    if (!advanceInSettlement) {
      // Someone else's settle landed first — that's a win, not a failure.
      DebugHub.logCheckpoint("Prize:Settle Raced", "pass");
      if (btn) { btn.textContent = "Already settled ✓"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 1500); }
      return;
    }
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleSettleNow.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleSettleNow", err);
    DebugHub.logCheckpoint("Prize:Settle Failed", "fail");
    if (btn) { btn.textContent = "Failed — try again"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 2000); }
  }
}

async function handleAdvance() {
  if (!userAddress) return;
  if (advanceInSettlement) return handleSettleNow();
  const btn = document.getElementById("advance-submit-btn");
  const count = advanceCount;
  const orig = btn ? btn.textContent : "";
  try {
    if (btn) { btn.disabled = true; btn.textContent = count > 1 ? `Advancing ×${count}…` : "Advancing…"; }
    DebugHub.logCheckpoint("Prize:Advance Requested", "pass");
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_NUDGE_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await router.advanceScroll(count, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Advance Confirmed", "pass");
    if (btn) btn.textContent = "Advanced ✓";
    await pollRoundState();
    setTimeout(() => { if (btn) { btn.disabled = false; renderAdvancePreview(); } }, 1500);
  } catch (err) {
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleAdvance.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleAdvance", err);
    DebugHub.logCheckpoint("Prize:Advance Failed", "fail");
    if (sel && ADVANCE_REVERTS[sel]) alert(ADVANCE_REVERTS[sel]);
    if (btn) { btn.textContent = "Failed — try again"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 2000); }
  }
}

// ─── Cancel Pending Entry (pre-round withdraw) ────────────────────────────────

async function handleCancelEntry() {
  try {
    DebugHub.logCheckpoint("Prize:Cancel Requested", "pass");
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    // v2: cancels the wallet's live Pending ticket (pre-round) — no args.
    await confirmTx(await registry.cancelEntry({ ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Cancel Confirmed", "pass");
    await loadMyEntries(); // also refreshes hasPlayEntry / the entry button
  } catch (err) {
    DebugHub.logError("handleCancelEntry", err);
    DebugHub.logCheckpoint("Prize:Cancel Failed", "fail");
    alert("Withdraw failed: " + (err?.reason || err.message));
  }
}

// ─── Claim Winnings ───────────────────────────────────────────────────────────

async function handleClaimWinnings(round) {
  const btn = document.getElementById("claim-btn-" + round);
  if (btn) { btn.disabled = true; btn.textContent = "Claiming…"; }
  try {
    DebugHub.logCheckpoint("Prize:Claim Requested", "pass");
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await prize.claimWinnings(round, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Claim Confirmed", "pass");
    if (btn) btn.textContent = "Claimed ✓";
    await loadPastRounds();
  } catch (err) {
    DebugHub.logError("handleClaimWinnings", err);
    DebugHub.logCheckpoint("Prize:Claim Failed", "fail");
    if (btn) { btn.textContent = "Failed"; btn.disabled = false; }
  }
}

// ─── Past Rounds ──────────────────────────────────────────────────────────────

// Recent Rounds — the last 8 settled rounds, newest first. No pagination.
const PAST_ROUNDS_MAX = 8;
async function loadPastRounds() {
  const list = document.getElementById("past-rounds-list");
  const hasRows = () => !!list.querySelector(".past-round-row");
  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());

    // Anchor round: currentRoundNum is set by pollRoundState, but init runs
    // these in parallel so it can still be null here — read the on-chain round
    // as a fallback so the section doesn't wrongly show "No completed rounds".
    let round = currentRoundNum;
    if (!round) { try { round = (await prize.getRoundState()).round.toNumber(); } catch {} }
    if (!round || round <= 1) {
      if (!hasRows()) list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
      return;
    }

    // Fetch up to the last 8 rounds concurrently (was serial per-round).
    const ids = [];
    for (let r = round - 1; r >= Math.max(1, round - PAST_ROUNDS_MAX); r--) ids.push(r);
    const results = await Promise.all(ids.map(r =>
      prize.getRoundResult(r).then(res => ({ r, res })).catch(() => null)
    ));
    const settled = results.filter(x => {
      if (!x) return false;
      const ws = bytes6ToStr(x.res.winningString);
      return ws && ws !== "——";
    });

    // Claim state for rounds THIS wallet won (parallel).
    const claimed = {};
    if (userAddress) {
      await Promise.all(settled.map(async ({ r, res }) => {
        if (res.winners.map(w => w.toLowerCase()).includes(userAddress.toLowerCase())) {
          claimed[r] = await prize.hasClaimed(r, userAddress).catch(() => true);
        }
      }));
    }

    if (!settled.length) {
      if (!hasRows()) list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
      return;
    }

    list.innerHTML = settled.map(({ r, res }) => {
      const ws = bytes6ToStr(res.winningString);
      let claimHtml = "";
      if (userAddress && res.winners.length > 0 &&
          res.winners.map(w => w.toLowerCase()).includes(userAddress.toLowerCase())) {
        const inWindow = round <= r + 3;
        if (!claimed[r] && inWindow) {
          claimHtml = `<button id="claim-btn-${r}" class="btn-claim-round" onclick="handleClaimWinnings(${r})">Claim ${fmt(res.perWinner)} ETH</button>`;
        } else if (claimed[r]) {
          claimHtml = `<span class="claimed-badge">Claimed ✓</span>`;
        } else {
          claimHtml = `<span class="expired-badge">Window closed</span>`;
        }
      }
      const winnerCls = claimHtml.includes("btn-claim") ? " past-round-winner" : "";
      return `<div class="past-round-row${winnerCls}">
          <div class="past-round-left">
            <span class="past-round-num">Round ${r}</span>
            <span class="past-round-string">${ws}</span>
          </div>
          <div class="past-round-right">
            <span class="past-round-meta">${res.winners.length} winner${res.winners.length !== 1 ? "s" : ""} · ${fmt(res.potAmount)} ETH</span>
            ${claimHtml}
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    DebugHub.logError("loadPastRounds", e); // keep whatever's shown on a transient failure
  }
}

// ─── Wallet Connect ───────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession();
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  updateEntryButton();
  await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
  refreshEntryBalance();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    updateEntryButton();
    await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
    refreshEntryBalance();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateEntryButton();
  loadMyEntries();
  pollRoundState(); // re-render to hide active digit
  refreshEntryBalance(); // clears the balance line while disconnected
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  DebugHub.logCheckpoint("Compete:Page Loaded", "pass");

  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _el = document.getElementById("wallet-addr");
    if (_el) _el.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    // Reflect the connected state on the entry button immediately; without this
    // it keeps reading "Connect wallet to enter" until the user types.
    updateEntryButton();
    refreshEntryBalance();
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _addrEl = document.getElementById("wallet-addr");
      if (_addrEl) _addrEl.textContent = fmtAddr(newAddr);
      updateEntryButton();
      await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
      refreshEntryBalance();
    });
  } else {
    // Not connected — run the CONNECT WALLET marquee right away so no real
    // digits flash before the first poll resolves.
    startGateMask();
  }

  // These five loaders hit the RPC independently — fire them in parallel so
  // the page paints on the slowest single round-trip instead of the sum of
  // all five. (Order between them doesn't matter; each renders on resolve.)
  await Promise.all([
    loadEntryCosts(),
    buildTokenDropdown(),
    pollRoundState(),
    loadMyEntries(),
    loadPastRounds(),
  ]);
  refreshEntryBalance(); // show the entry-token balance on load, not just after a tap

  // Timer tick every second, full state every 4s
  setInterval(async () => {
    const timerEl = document.getElementById("sub-timer");
    if (timerEl && timerEl.textContent.includes(":")) {
      const [mm, ss] = timerEl.textContent.split(":").map(p => parseInt(p));
      if (!isNaN(mm) && !isNaN(ss)) {
        const total = mm * 60 + ss;
        if (total > 0) {
          const nm = String(Math.floor((total-1)/60)).padStart(2,"0");
          const ns = String((total-1) % 60).padStart(2,"0");
          const updatedText = `${nm}:${ns} left in segment`;
          timerEl.textContent = updatedText;
        }
      }
    }
  }, 1000);

  // Skip the RPC polls while the tab is hidden — no point (and no battery/
  // data cost) refreshing state nobody is looking at. On return to the tab,
  // catch up immediately instead of waiting for the next interval.
  const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
  setInterval(whenVisible(pollRoundState), 4000);
  setInterval(whenVisible(loadPastRounds), 30000);
  // Keep the entry-token balance current (drops after an entry, rises after a
  // faucet/transfer) without the user having to touch the selector.
  setInterval(whenVisible(refreshEntryBalance), 12000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { pollRoundState(); refreshEntryBalance(); }
  });
})();
