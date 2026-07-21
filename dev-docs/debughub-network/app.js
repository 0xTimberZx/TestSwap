/* ============================================================
   DebugHub Dashboard Logic
   Version: network-read (Supabase) — drop-in replacement for
   MyDapp/debughub/app.js.

   Reads telemetry from the Supabase sink so the hub aggregates every
   app across origins AND devices. Falls back to same-origin
   localStorage when the backend is unconfigured or a fetch fails, so
   nothing breaks offline. Everything below the data layer (gate,
   tabs, error catalog, export) is unchanged from the original.
   ============================================================ */

(function () {
  "use strict";

  // Network sink (same project the SDK posts to). Blank ⇒ localStorage-only.
  var SUPABASE_URL = "https://ipyfodnidwsdvwqrcjrl.supabase.co";
  var SUPABASE_KEY = "sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9";

  // List of DApps DebugHub knows about.
  // key = app name (must match DEBUGHUB_CONFIG.appName in each DApp)
  var APPS = [
    { key: "Faucet",       label: "0xFaucet" },
    { key: "BlockpotDAO",  label: "BlockpotDAO" },
    { key: "MessageBoard", label: "MessageBoard" },
    { key: "TimbSwap",     label: "TimbSwap" },
    { key: "TestApp",      label: "TestApp (dev)" }
  ];

  var TABS = ["Sessions", "Checkpoints", "Errors", "Wallets"];

  var state = {
    selectedApp: APPS[0].key,
    activeTab: "Sessions"
  };

  // ---------- data source (remote cache + localStorage fallback) ----------

  var _remote = {};        // appKey -> [events] mapped to the SDK event shape
  var _remoteLoaded = {};  // appKey -> true once fetched (even if empty)

  function b64decode(str) {
    return decodeURIComponent(escape(atob(str)));
  }

  // Same-origin localStorage (offline / dev fallback).
  function loadLocal(appKey) {
    try {
      var raw = localStorage.getItem(appKey + "_sessions");
      if (!raw) return [];
      return JSON.parse(b64decode(raw));
    } catch (e) {
      return [];
    }
  }

  // Synchronous accessor used by every render function: prefer the remote
  // cache once it has data, else fall back to localStorage. Empty remote falls
  // through so same-origin apps that don't transmit (or an app with no rows
  // yet) still show their local data instead of a blank panel.
  function loadEvents(appKey) {
    if (_remoteLoaded[appKey] && _remote[appKey] && _remote[appKey].length) return _remote[appKey];
    return loadLocal(appKey);
  }

  // Fetch an app's events from Supabase, map DB columns back to the SDK event
  // shape the renderers expect (fn -> function, event_ts -> timestamp), cache,
  // then call cb. On any failure, mark loaded with whatever localStorage has so
  // the UI still shows something.
  function fetchRemote(appKey, cb) {
    if (!SUPABASE_URL || !SUPABASE_KEY) { _remoteLoaded[appKey] = true; cb && cb(); return; }
    // Newest 1000 events, not the oldest. With event_ts.asc the dashboard
    // fetched the FIRST 1000 rows ever recorded, so once the table passed 1000
    // rows it froze on ancient data and never showed recent activity. desc =
    // most-recent window; the renderers already sort by timestamp for display.
    var url = SUPABASE_URL.replace(/\/+$/, "") +
      "/rest/v1/debughub_events?app=eq." + encodeURIComponent(appKey) +
      "&order=event_ts.desc&limit=1000";
    fetch(url, { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (rows) {
        _remote[appKey] = (rows || []).map(function (r) {
          return {
            type: r.type,
            sessionId: r.session_id,
            app: r.app,
            sdkVersion: r.sdk_version,
            wallet: r.wallet,
            chainId: r.chain_id,
            timestamp: r.event_ts || (r.created_at ? new Date(r.created_at).getTime() : Date.now()),
            name: r.name,
            status: r.status,
            function: r.fn,
            code: r.code,
            message: r.message,
            label: r.label,
            durationMs: r.duration_ms
          };
        });
        _remoteLoaded[appKey] = true;
        cb && cb();
      })
      .catch(function () {
        // Fall back to localStorage for this app; don't cache remote so a later
        // refresh can retry.
        _remoteLoaded[appKey] = true;
        cb && cb();
      });
  }

  // Ensure the selected app's data is loaded, then paint. Shows a Loading state
  // on the first fetch so the panel isn't blank.
  function ensureLoadedThenPaint() {
    var appKey = state.selectedApp;
    if (_remoteLoaded[appKey]) { renderContent(); return; }
    var content = document.getElementById("content");
    if (content) {
      content.innerHTML =
        '<div class="empty-state"><div class="big">Loading…</div>' +
        "<div>Fetching " + appKey + " telemetry.</div></div>";
    }
    fetchRemote(appKey, renderContent);
  }

  // ---------- session grouping ----------

  function buildSessions(events) {
    var sessions = {}; // id -> { id, wallet, started, ended, lastCheckpoint, lastStatus }
    var order = [];

    events.forEach(function (evt) {
      var id = evt.sessionId;
      if (!id) return;

      if (!sessions[id]) {
        sessions[id] = {
          id: id,
          wallet: evt.wallet,
          started: null,
          ended: null,
          lastCheckpoint: null,
          lastStatus: null,
          lastTimestamp: evt.timestamp
        };
        order.push(id);
      }

      var s = sessions[id];
      s.lastTimestamp = evt.timestamp;

      if (evt.type === "session_start") s.started = evt.timestamp;
      if (evt.type === "session_end") s.ended = evt.timestamp;

      if (evt.type === "checkpoint" || evt.type === "security") {
        s.lastCheckpoint = evt.name;
        s.lastStatus = evt.status;
      }

      if (evt.type === "error") {
        s.lastCheckpoint = "Error: " + (evt.functionName || evt.function || "unknown");
        s.lastStatus = "fail";
      }
    });

    // newest first
    return order
      .map(function (id) { return sessions[id]; })
      .sort(function (a, b) { return b.lastTimestamp - a.lastTimestamp; });
  }

  // ---------- formatting ----------

  function shortWallet(addr) {
    if (!addr) return "—";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function formatTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function statusClass(session) {
    if (!session.ended) return "active";
    return session.lastStatus === "fail" ? "fail" : "pass";
  }

  function statusLabel(session) {
    if (!session.ended) return "ACTIVE";
    return session.lastStatus === "fail" ? "FAIL" : "PASS";
  }

  // ---------- rendering ----------

  function renderSessionsTab(appKey) {
    var events = loadEvents(appKey);
    var sessions = buildSessions(events);

    if (sessions.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="big">No sessions yet</div>' +
        "<div>Events will appear here once " + appKey + " starts logging.</div>" +
        "</div>"
      );
    }

    return sessions
      .map(function (s) {
        var cls = statusClass(s);
        return (
          '<div class="session-card">' +
          '<div class="session-top">' +
          '<div class="lamp ' + cls + '"></div>' +
          '<div class="session-id">' + s.id + "</div>" +
          '<div style="flex:1"></div>' +
          '<div class="status-badge ' + cls + '">' + statusLabel(s) + "</div>" +
          "</div>" +
          '<div class="session-row"><span class="label">Wallet</span><span class="value">' + shortWallet(s.wallet) + "</span></div>" +
          '<div class="session-row"><span class="label">Duration</span><span class="value">' + (s.ended && s.started ? Math.round((s.ended - s.started) / 1000) + "s" : "active") + "</span></div>" +
          '<div class="session-row"><span class="label">Last checkpoint</span><span class="value">' + (s.lastCheckpoint || "—") + "</span></div>" +
          '<div class="session-row"><span class="label">Last activity</span><span class="value">' + formatTime(s.lastTimestamp) + "</span></div>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderCheckpointsTab(appKey) {
    var events = loadEvents(appKey);

    var checkpoints = events.filter(function (evt) {
      return evt.type === "checkpoint" || evt.type === "security";
    });

    if (checkpoints.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="big">No checkpoints yet</div>' +
        "<div>Checkpoint and security events from " + appKey + " will appear here.</div>" +
        "</div>"
      );
    }

    // newest first
    checkpoints.sort(function (a, b) { return b.timestamp - a.timestamp; });

    return (
      '<div class="timeline">' +
      checkpoints
        .map(function (evt) {
          var cls = evt.status === "fail" ? "fail" : "pass";
          var kindLabel = evt.type === "security" ? "Security" : "Checkpoint";
          return (
            '<div class="timeline-item">' +
            '<div class="lamp ' + cls + '"></div>' +
            '<div class="timeline-body">' +
            '<div class="timeline-name">' + evt.name + "</div>" +
            '<div class="timeline-meta">' +
            "<span>" + kindLabel + "</span>" +
            "<span>" + shortWallet(evt.wallet) + "</span>" +
            "<span>" + formatTime(evt.timestamp) + "</span>" +
            "</div>" +
            '<div class="timeline-session">' + evt.sessionId + "</div>" +
            "</div>" +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  // ---------- error code lookup ----------

  var ERROR_EXPLANATIONS = {
    // ── Wallet / RPC ─────────────────────────────────────────────────────────
    "-32002": "Wallet already has a pending request — open MetaMask/Brave and check for a waiting popup.",
    "-32603": "Internal JSON-RPC error — often a contract revert or bad call data. Check the contract state and parameters.",
    "4001":   "The wallet rejected the request — user tapped Cancel or denied the signature.",
    "-32000": "Invalid input — often: (a) maxFeePerGas below base fee, (b) insufficient ETH for gas, or (c) bad tx parameters. Apply the 130% fee buffer fix.",
    "-32700": "Parse error — the RPC received malformed JSON. Usually a client-side serialisation bug.",
    "-32601": "Method not found — the RPC node does not support this call. Try a different RPC endpoint.",
    "-32003": "Transaction rejected — nonce too low or tx would fail on-chain. Fetch a fresh pending nonce.",
    "-32005": "RPC rate limit exceeded. Add a delay or switch RPC endpoints.",
    "SERVER_ERROR_401": "RPC endpoint returned 401 Unauthorized — ARB_SEPOLIA_RPC secret is missing, expired, or API key is invalid.",
    "UNSUPPORTED_OPERATION": "Wallet session dropped — the signer has no account behind it (browser backgrounded or wallet auto-locked). Reconnect the wallet. DApp-side fix: re-validate eth_accounts before every write (getFreshSigner pattern, see wallet-switch-fix skill).",
    // ── Transaction / Nonce ──────────────────────────────────────────────────
    "NONCE_EXPIRED":           "Nonce too low — always fetch via getTransactionCount(address, 'pending') on every write call.",
    "REPLACEMENT_UNDERPRICED": "A pending tx with the same nonce exists. Wait for it to confirm or resend with higher gas.",
    "UNPREDICTABLE_GAS_LIMIT": "Gas estimation failed — tx would revert. Check allowances, contract state, and input params.",
    "CALL_EXCEPTION":          "Contract call reverted. Check: allowance, entry cost, contract not paused, correct address in config.js.",
    "INSUFFICIENT_FUNDS":      "Wallet has insufficient ETH for gas. Top up from 0xFaucet.",
    "NETWORK_ERROR":           "Lost connection to RPC node. Check internet connection and retry.",
    "TIMEOUT":                 "RPC request timed out. Node may be congested — retry.",
    // ── TimbSwap: Swap ───────────────────────────────────────────────────────
    "InsufficientOutputAmount": "Swap slippage exceeded — price moved before tx confirmed. Increase slippage tolerance or retry.",
    "ExcessiveInputAmount":     "Swap exact-out: required input exceeded amountInMax. Increase slippage tolerance.",
    "PairNotFound":             "No liquidity pair exists for this token combination.",
    "RouterPaused":             "TimbSwap Router is paused. No swaps until unpaused.",
    "Expired":                  "Transaction deadline passed. Increase the deadline or submit faster.",
    "WethNotSet":               "WETH address not configured on Router. Call router.setWeth().",
    "RefundFailed":             "ETH refund after addLiquidityETH failed — recipient may be a contract rejecting ETH.",
    "InsufficientLiquidity":    "Insufficient liquidity in the pool for this trade size.",
    // ── TimbSwap: Prize Game ─────────────────────────────────────────────────
    "InvalidCharacter":     "Entry string has an invalid character — only A-Z and 0-9 allowed.",
    "RepeatingCharacter":   "Entry string has a repeating character — all 6 must be unique.",
    "ActiveEntryExists":    "You already have an active entry for this round. Use Replace Entry.",
    "LockNotUnlocked":      "Lock duration has not elapsed. Check timeUntilUnlock() for remaining time.",
    "NotLocker":            "Only the original locker can withdraw this lock.",
    "ClaimWindowClosed":    "Claim window closed — 2 rounds after last eligible round.",
    "GameNotStarted":       "TimbPrize.startGame() has not been called yet.",
    "SettlementPaused":     "Settlement is paused by the owner.",
    "NotSettler":           "Only the designated settler address can call settleSegment().",
    "SegmentNotComplete":   "Segment interaction window has not elapsed yet. Settler called too early.",
    "RoundNotSettled":      "Round has not been settled yet — no winner data available.",
    "AlreadyClaimed":       "Winnings already claimed for this round.",
    "NotAWinner":           "This wallet is not a documented winner for the requested round.",
    // ── TimbSwap: Staking / Farm ─────────────────────────────────────────────
    "LpTokenNotSet":        "LP token not set on TimbFarm. Call farm.setLpToken().",
    "LpTokenAlreadyLocked": "LP token is locked after first stake and cannot be changed.",
    // ── Governance ───────────────────────────────────────────────────────────
    "BelowThreshold":       "TIMBS balance is below the proposal threshold required to create a proposal.",
    "AlreadyVoted":         "This wallet has already voted on this proposal.",
    "VotingPowerLocked":    "Voting power is locked — you have participated in an active or passed proposal.",
    "ProposalNotActive":    "Proposal is not in active voting state.",
    "ProposalNotPassed":    "Proposal has not passed — cannot execute.",
    "ExecutionWindowExpired": "Execution window has closed — proposal has expired.",
    "WRONG_CHAIN":          "Wrong network — TimbSwap requires Arbitrum Sepolia (Chain ID: 421614). Switch in your wallet.",
    // ── Liquidity ─────────────────────────────────────────────────────────────
    "InsufficientAAmount":     "removeLiquidity: received less tokenA than amountAMin. Increase slippage tolerance or reduce the liquidity amount.",
    "InsufficientBAmount":     "removeLiquidity: received less tokenB than amountBMin. Increase slippage tolerance or reduce the liquidity amount.",
    // ── Governance ───────────────────────────────────────────────────────────
    "InsufficientVotingPower": "No TIMBS deposited in governance contract. Call depositVotingPower() before attempting to vote.",
    "QuorumNotReached":        "Proposal reached vote threshold but total participation was below the quorum requirement."
  };

  function explainError(evt) {
    var code = evt.code !== null && evt.code !== undefined ? String(evt.code) : null;
    if (code && ERROR_EXPLANATIONS[code]) {
      return ERROR_EXPLANATIONS[code];
    }
    if (evt.message) {
      return evt.message;
    }
    return "Unrecognized error — see raw details below.";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderErrorsTab(appKey) {
    var events = loadEvents(appKey);
    var errors = events.filter(function (evt) { return evt.type === "error"; });

    if (errors.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="big">No errors logged</div>' +
        "<div>Caught errors from " + appKey + " will appear here.</div>" +
        "</div>"
      );
    }

    // group + dedupe by function + code + message
    var groups = {};
    var order = [];

    errors.forEach(function (evt) {
      var fn = evt.function || evt.functionName;
      var key = fn + "|" + evt.code + "|" + evt.message;
      if (!groups[key]) {
        groups[key] = {
          function: fn,
          code: evt.code,
          message: evt.message,
          count: 0,
          lastSeen: evt.timestamp,
          raw: evt
        };
        order.push(key);
      }
      var g = groups[key];
      g.count += 1;
      if (evt.timestamp > g.lastSeen) {
        g.lastSeen = evt.timestamp;
        g.raw = evt;
      }
    });

    var groupList = order.map(function (key) { return groups[key]; });
    groupList.sort(function (a, b) { return b.lastSeen - a.lastSeen; });

    return groupList
      .map(function (g, i) {
        var rawJson = JSON.stringify(g.raw, null, 2);
        return (
          '<div class="error-card">' +
          '<div class="error-explanation">' + escapeHtml(explainError(g.raw)) + "</div>" +
          '<div class="error-meta">' +
          "<span><strong>" + escapeHtml(g.function) + "</strong>()</span>" +
          "<span>x" + g.count + "</span>" +
          "<span>" + formatTime(g.lastSeen) + "</span>" +
          "</div>" +
          "<details>" +
          "<summary>Raw error details</summary>" +
          '<pre class="error-raw" id="raw-' + i + '">' + escapeHtml(rawJson) + "</pre>" +
          '<button class="copy-btn" data-target="raw-' + i + '">Copy</button>' +
          "</details>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderWalletsTab(appKey) {
    var events = loadEvents(appKey);

    var wallets = {}; // addr -> { connections, errors, pass, fail }
    var order = [];

    events.forEach(function (evt) {
      var addr = (evt.wallet || "unknown").toLowerCase(); // dedupe mixed-case
      if (!wallets[addr]) {
        wallets[addr] = { connections: 0, errors: 0, pass: 0, fail: 0 };
        order.push(addr);
      }
      var w = wallets[addr];

      if (evt.type === "session_start") w.connections += 1;
      if (evt.type === "error") w.errors += 1;
      if (evt.type === "checkpoint" || evt.type === "security") {
        if (evt.status === "fail") w.fail += 1;
        else w.pass += 1;
      }
    });

    if (order.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="big">No wallets seen yet</div>' +
        "<div>Wallets that connect to " + appKey + " will appear here.</div>" +
        "</div>"
      );
    }

    // sort by most connections first
    order.sort(function (a, b) { return wallets[b].connections - wallets[a].connections; });

    return order
      .map(function (addr) {
        var w = wallets[addr];
        var total = w.pass + w.fail;
        var rate = total > 0 ? Math.round((w.pass / total) * 100) : 100;

        return (
          '<div class="wallet-card">' +
          '<div class="wallet-addr">' + shortWallet(addr === "unknown" ? null : addr) + "</div>" +
          '<div class="session-row"><span class="label">Connections</span><span class="value">' + w.connections + "</span></div>" +
          '<div class="session-row"><span class="label">Errors</span><span class="value">' + w.errors + "</span></div>" +
          '<div class="session-row"><span class="label">Success rate</span><span class="value">' + rate + "%</span></div>" +
          '<div class="rate-bar"><div class="rate-bar-fill" style="width:' + rate + '%"></div></div>' +
          "</div>"
        );
      })
      .join("");
  }

  function renderPlaceholderTab(name) {
    return (
      '<div class="empty-state">' +
      '<div class="big">' + name + "</div>" +
      "<div>This tab is coming in a future pass.</div>" +
      "</div>"
    );
  }

  function renderContent() {
    var content = document.getElementById("content");
    if (!content) return;
    if (state.activeTab === "Sessions") {
      content.innerHTML = renderSessionsTab(state.selectedApp);
    } else if (state.activeTab === "Checkpoints") {
      content.innerHTML = renderCheckpointsTab(state.selectedApp);
    } else if (state.activeTab === "Errors") {
      content.innerHTML = renderErrorsTab(state.selectedApp);
      content.querySelectorAll(".copy-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var pre = document.getElementById(btn.getAttribute("data-target"));
          if (!pre) return;
          var text = pre.textContent;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              btn.textContent = "Copied!";
              setTimeout(function () { btn.textContent = "Copy"; }, 1200);
            });
          }
        });
      });
    } else if (state.activeTab === "Wallets") {
      content.innerHTML = renderWalletsTab(state.selectedApp);
    } else {
      content.innerHTML = renderPlaceholderTab(state.activeTab);
    }
  }

  function renderTabs() {
    var nav = document.getElementById("tab-nav");
    if (!nav) return;
    nav.innerHTML = TABS.map(function (tab) {
      var cls = tab === state.activeTab ? "active" : "";
      return '<button class="' + cls + '" data-tab="' + tab + '">' + tab + "</button>";
    }).join("");

    nav.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.activeTab = btn.getAttribute("data-tab");
        renderTabs();
        renderContent(); // data already loaded for the selected app
      });
    });
  }

  function exportCurrentApp() {
    var events = loadEvents(state.selectedApp);
    var json = JSON.stringify(events, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);

    var a = document.createElement("a");
    a.href = url;
    a.download = state.selectedApp + "_debughub_export.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function renderAppSelector() {
    var select = document.getElementById("app-select");
    if (!select) return;
    select.innerHTML = APPS.map(function (app) {
      return '<option value="' + app.key + '">' + app.label + "</option>";
    }).join("");

    select.value = state.selectedApp;

    select.addEventListener("change", function () {
      state.selectedApp = select.value;
      // Re-fetch on switch so each app pulls fresh data (also doubles as refresh
      // when re-selecting the same app).
      _remoteLoaded[state.selectedApp] = false;
      ensureLoadedThenPaint();
    });

    var exportBtn = document.getElementById("export-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", exportCurrentApp);
    }
  }

  function showDashboard(address) {
    var gateScreen = document.getElementById("gate-screen");
    var dashboard = document.getElementById("dashboard");
    var ownerAddr = document.getElementById("owner-address");

    if (gateScreen) gateScreen.style.display = "none";
    if (dashboard) dashboard.style.display = "block";
    if (ownerAddr) ownerAddr.textContent = shortWallet(address);

    renderAppSelector();
    renderTabs();
    ensureLoadedThenPaint(); // fetch the initial app, then paint
  }

  function showGate(message, isError) {
    var dashboard = document.getElementById("dashboard");
    var gate = document.getElementById("gate-screen");
    var statusEl = document.getElementById("gate-status");

    if (dashboard) dashboard.style.display = "none";
    if (gate) gate.style.display = "block";

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = "status-line " + (isError ? "status-fail" : "");
    }
  }

  // ---------- init ----------

  var connectBtn = document.getElementById("connect-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", function () {
      DebugHubGate.connect({
        onAuthorized: showDashboard,
        onUnauthorized: function (addr) {
          showGate("Connected as " + shortWallet(addr) + " — this wallet is not authorized.", true);
        },
        onNotConnected: function (reason) {
          if (reason === "no_wallet") {
            showGate("No wallet extension detected.", true);
          } else {
            showGate("Connect your wallet to continue.", false);
          }
        }
      });
    });
  }

  DebugHubGate.init(
    showDashboard,
    function (addr) {
      showGate("Connected as " + shortWallet(addr) + " — this wallet is not authorized.", true);
    },
    function (reason) {
      if (reason === "no_wallet") {
        showGate("No wallet extension detected.", true);
      } else {
        showGate("Connect your wallet to continue.", false);
      }
    }
  );
})();
