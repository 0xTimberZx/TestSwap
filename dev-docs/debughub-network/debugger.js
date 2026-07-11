/* ============================================================
   DebugHub SDK
   Version: 1.2.0  (network sink added — backward compatible)

   Drop-in replacement for MyDapp/debughub/sdk/debugger.js.

   Usage: add this script tag BEFORE your app.js, and define
     window.DEBUGHUB_CONFIG = {
       appName:     "TimbSwap",
       // Optional network sink. When both are present the SDK POSTs
       // every event to Supabase in addition to localStorage, so the
       // hub can aggregate across origins AND devices. Omit them and
       // the SDK behaves exactly like 1.1.0 (localStorage only).
       supabaseUrl: "https://ipyfodnidwsdvwqrcjrl.supabase.co",
       supabaseKey: "sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9"
     };
   before it loads. supabaseUrl/Key are read lazily (at send time), so
   a later script (e.g. config.js) may fill them in after this SDK loads.

   Exposes window.DebugHub with:
     startSession() / endSession()
     logCheckpoint(name, status)   status: "pass" | "fail"
     logError(functionName, error)
     logPerf(label, durationMs)
     logSecurity(name, status)     status: "pass" | "fail"
   ============================================================ */

(function () {
  "use strict";

  var SDK_VERSION = "1.2.0";
  var MAX_EVENTS = 200;

  var config = window.DEBUGHUB_CONFIG || {};
  var APP_NAME = config.appName || "Unknown";
  var STORAGE_KEY = APP_NAME + "_sessions";

  var storageOk = true;
  var currentSession = null; // { id, wallet, chainId, startedAt }

  // ---------- storage helpers ----------

  function testStorage() {
    try {
      var k = "__debughub_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(str) { return decodeURIComponent(escape(atob(str))); }

  function loadEvents() {
    if (!storageOk) return [];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(b64decode(raw));
    } catch (e) {
      return [];
    }
  }

  function saveEvents(events) {
    if (!storageOk) return;
    try {
      if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
      localStorage.setItem(STORAGE_KEY, b64encode(JSON.stringify(events)));
    } catch (e) {
      storageOk = false;
      warn("Could not write to storage");
    }
  }

  function pushEvent(event) {
    // Local ring buffer (offline fallback + the 1.1.0 behaviour).
    if (storageOk) {
      var events = loadEvents();
      events.push(event);
      saveEvents(events);
    }
    // Remote sink (no-op when unconfigured).
    transmit(event);
  }

  // ---------- remote sink ----------

  function truncate(s, n) {
    if (s == null) return null;
    s = String(s);
    return s.length > n ? s.slice(0, n) : s;
  }

  // Fire-and-forget POST to Supabase (PostgREST). Read the endpoint lazily so
  // a config script that runs after this SDK can still supply it. `keepalive`
  // lets the session_end event flush during beforeunload. All failures are
  // swallowed — telemetry must never affect the host app, and the event is
  // already in localStorage as a fallback.
  function transmit(event) {
    var cfg = window.DEBUGHUB_CONFIG || config;
    var url = cfg.supabaseUrl, key = cfg.supabaseKey;
    if (!url || !key || typeof fetch !== "function") return;
    try {
      var row = {
        app:         event.app,
        type:        event.type,
        session_id:  event.sessionId || null,
        wallet:      event.wallet || null,
        chain_id:    (typeof event.chainId === "number") ? event.chainId : null,
        sdk_version: event.sdkVersion || null,
        name:        truncate(event.name, 200),
        status:      event.status || null,
        fn:          event.function || null,
        code:        (event.code !== undefined && event.code !== null) ? String(event.code) : null,
        message:     truncate(event.message, 2000),
        label:       truncate(event.label, 200),
        duration_ms: (typeof event.durationMs === "number") ? Math.round(event.durationMs) : null,
        event_ts:    event.timestamp || null
      };
      fetch(url.replace(/\/+$/, "") + "/rest/v1/debughub_events", {
        method: "POST",
        headers: {
          "apikey": key,
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(row),
        keepalive: true,
        mode: "cors"
      }).catch(function () {});
    } catch (e) { /* never throw from telemetry */ }
  }

  // ---------- console feedback (silent unless storage fails) ----------

  function warn(msg) { console.warn("❌ DebugHub: " + msg); }
  function ok(msg)   { console.log("✅ DebugHub: " + msg); }

  // ---------- wallet / chain detection ----------

  function getWallet() {
    try {
      if (window.ethereum && window.ethereum.selectedAddress) return window.ethereum.selectedAddress.toLowerCase();
    } catch (e) {}
    return null;
  }

  function getChainId() {
    try {
      if (window.ethereum && window.ethereum.chainId) return parseInt(window.ethereum.chainId, 16);
    } catch (e) {}
    return null;
  }

  // ---------- session id ----------

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function genSessionId(wallet) {
    var now = new Date();
    var mmss = pad2(now.getMinutes()) + pad2(now.getSeconds());
    var walletPrefix = wallet ? wallet.slice(0, 5) : "0xNNN";
    return APP_NAME.toLowerCase() + "-" + mmss + "-" + walletPrefix;
  }

  // ---------- base event shape ----------

  function baseEvent(type) {
    return {
      type: type,
      sessionId: currentSession ? currentSession.id : null,
      app: APP_NAME,
      sdkVersion: SDK_VERSION,
      wallet: currentSession ? currentSession.wallet : getWallet(),
      chainId: currentSession ? currentSession.chainId : getChainId(),
      timestamp: Date.now()
    };
  }

  // ---------- public API ----------

  function startSession(walletOverride) {
    // Normalize case so the same wallet from different sources (checksummed
    // override vs lowercase eth_accounts/selectedAddress) never double-logs.
    var wallet = walletOverride || getWallet();
    if (wallet) wallet = wallet.toLowerCase();
    var chainId = getChainId();

    currentSession = { id: genSessionId(wallet), wallet: wallet, chainId: chainId, startedAt: Date.now() };

    pushEvent(baseEvent("session_start"));

    if (!wallet && window.ethereum) {
      var sec = baseEvent("security");
      sec.name = "Wallet Detect";
      sec.status = "fail";
      pushEvent(sec);
      backfillWallet(currentSession);
    }
    return currentSession.id;
  }

  function backfillWallet(session) {
    try {
      window.ethereum.request({ method: "eth_accounts" }).then(function (accounts) {
        if (accounts && accounts.length > 0 && currentSession === session && !currentSession.wallet) {
          currentSession.wallet = accounts[0].toLowerCase();
        }
      }).catch(function () {});
    } catch (e) {}
  }

  function endSession() {
    if (!currentSession) return;
    pushEvent(baseEvent("session_end"));
    currentSession = null;
  }

  function logCheckpoint(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("checkpoint");
    evt.name = name;
    evt.status = status || "pass";
    pushEvent(evt);
  }

  function logError(functionName, error) {
    if (!currentSession) startSession();
    var evt = baseEvent("error");
    evt.function = functionName;
    if (error && typeof error === "object") {
      evt.code = error.code !== undefined ? error.code : null;
      evt.message = error.message || String(error);
    } else {
      evt.code = null;
      evt.message = String(error);
    }
    pushEvent(evt);
  }

  function logPerf(label, durationMs) {
    if (!currentSession) startSession();
    var evt = baseEvent("perf");
    evt.label = label;
    evt.durationMs = durationMs;
    pushEvent(evt);
  }

  function logSecurity(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("security");
    evt.name = name;
    evt.status = status || "fail";
    pushEvent(evt);
  }

  // ---------- wallet event wiring ----------

  function wireWalletEvents() {
    if (!window.ethereum || !window.ethereum.on) return;

    window.ethereum.on("accountsChanged", function (accounts) {
      if (!accounts || accounts.length === 0) {
        if (currentSession) {
          var sec = baseEvent("security");
          sec.name = "Wallet Dropped";
          sec.status = "fail";
          pushEvent(sec);
        }
        endSession();
        return;
      }
      endSession();
      startSession(accounts[0]);
    });

    window.ethereum.on("disconnect", function () { endSession(); });
  }

  window.addEventListener("beforeunload", function () { endSession(); });

  // ---------- init ----------

  storageOk = testStorage();
  if (!storageOk) warn("localStorage unavailable - events will not be logged");
  else ok("ready (" + APP_NAME + " · v" + SDK_VERSION + ")");

  wireWalletEvents();

  window.DebugHub = {
    startSession: startSession,
    endSession: endSession,
    logCheckpoint: logCheckpoint,
    logError: logError,
    logPerf: logPerf,
    logSecurity: logSecurity
  };
})();
