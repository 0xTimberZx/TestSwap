// Gas request board on /start (testnet only). Newcomers the public faucets turn
// away (they want a mainnet balance) post their address; anyone can send them
// 0.003 test ETH on Arbitrum Sepolia and paste the transaction hash, which the
// `gas-board` edge function checks on chain. The team fills anything still open
// after 6 hours (not advertised on the page). No points for filling: it is a thank-you, not a score.
(function () {
  "use strict";
  var ENDPOINT = "/api/gas-board";
  var board = document.getElementById("gas-board");
  if (!board) return;
  // Mainnet build: real ETH is bought, not begged. The board is testnet-only.
  if (typeof NET_IS_MAINNET !== "undefined" && NET_IS_MAINNET) { board.style.display = "none"; return; }

  var form = document.getElementById("gb-form");
  var addrEl = document.getElementById("gb-addr");
  var submitEl = document.getElementById("gb-submit");
  var msgEl = document.getElementById("gb-msg");
  var listEl = document.getElementById("gb-list");
  var statsEl = document.getElementById("gb-stats");
  var countEl = document.getElementById("gb-count");
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  var HASH_RE = /^0x[0-9a-fA-F]{64}$/;

  function post(body) {
    return fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "The board is unavailable right now." }; }); })
      .catch(function () { return { ok: false, error: "The board is unavailable right now." }; });
  }
  function say(text, kind) { msgEl.textContent = text || ""; msgEl.className = "gb-msg" + (kind ? " " + kind : ""); }
  function ago(iso) {
    var mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return mins + " min";
    var h = Math.floor(mins / 60);
    return h + " h" + (mins % 60 ? " " + (mins % 60) + " min" : "");
  }

  // Turnstile: rendered when the site key is set (config.js), as on the waitlist.
  var tsWidget = null;
  function renderTurnstile() {
    var key = window.TURNSTILE_SITE_KEY;
    if (!key || !window.turnstile || tsWidget !== null) return;
    try { tsWidget = window.turnstile.render("#gb-turnstile", { sitekey: key, theme: "dark" }); } catch (e) { tsWidget = null; }
  }
  function tsToken() { try { return tsWidget !== null ? window.turnstile.getResponse(tsWidget) || "" : ""; } catch (e) { return ""; } }
  function tsReset() { try { if (tsWidget !== null) window.turnstile.reset(tsWidget); } catch (e) {} }
  function startTs() { (function waitTs(n) { if (window.turnstile) renderTurnstile(); else if (n > 0) setTimeout(function () { waitTs(n - 1); }, 300); })(40); }
  // Minimized by default: a closed <details> leaves the widget no layout, so
  // Turnstile renders the first time the board is opened.
  board.addEventListener("toggle", function () { if (board.open) startTs(); });
  if (board.open) startTs();

  function row(r) {
    var div = document.createElement("div");
    div.className = "gb-row";
    var top = document.createElement("div"); top.className = "gb-row-top";
    var a = document.createElement("span"); a.className = "gb-addr"; a.textContent = r.address;
    var age = document.createElement("span"); age.className = "gb-age"; age.textContent = "waiting " + ago(r.created_at);
    var copy = document.createElement("button"); copy.type = "button"; copy.className = "gb-small tap"; copy.textContent = "Copy";
    copy.addEventListener("click", function () {
      try { navigator.clipboard.writeText(r.address); copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1500); } catch (e) {}
    });
    var sent = document.createElement("button"); sent.type = "button"; sent.className = "gb-small tap"; sent.textContent = "I sent it";
    top.appendChild(a); top.appendChild(age); top.appendChild(copy); top.appendChild(sent);
    div.appendChild(top);
    sent.addEventListener("click", function () {
      if (div.querySelector(".gb-fill")) return;
      var f = document.createElement("div"); f.className = "gb-fill";
      var inp = document.createElement("input"); inp.className = "gb-input"; inp.placeholder = "Paste the transaction hash (0x…)";
      inp.maxLength = 66; inp.spellcheck = false; inp.autocomplete = "off";
      var ok = document.createElement("button"); ok.type = "button"; ok.className = "gb-small tap"; ok.textContent = "Confirm";
      f.appendChild(inp); f.appendChild(ok); div.appendChild(f); inp.focus();
      ok.addEventListener("click", function () {
        var h = inp.value.trim();
        if (!HASH_RE.test(h)) { say("Paste the full transaction hash (0x… 66 characters).", "err"); return; }
        ok.disabled = true; say("Checking the transaction on chain…");
        post({ action: "fill", id: r.id, txHash: h }).then(function (res) {
          ok.disabled = false;
          if (res.ok) { say("Thanks — that request is filled.", "ok"); load(); }
          else say(res.error || "Couldn't confirm that transaction.", "err");
        });
      });
    });
    return div;
  }

  function load() {
    post({ action: "list" }).then(function (res) {
      if (!res.ok) { listEl.innerHTML = ""; var e = document.createElement("div"); e.className = "gb-empty"; e.textContent = res.error || "The board is unavailable right now."; listEl.appendChild(e); return; }
      listEl.innerHTML = "";
      if (!res.open.length) { var none = document.createElement("div"); none.className = "gb-empty"; none.textContent = "The board is currently empty."; listEl.appendChild(none); }
      res.open.forEach(function (r) { listEl.appendChild(row(r)); });
      countEl.textContent = res.open.length ? res.open.length + " waiting" : "";
      statsEl.textContent = res.filledThisWeek ? "· filled this week: " + res.filledThisWeek + (res.filledByCommunity ? " (" + res.filledByCommunity + " by the community)" : "") : "";
    });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var a = addrEl.value.trim();
    if (!ADDR_RE.test(a)) { say("Enter a valid wallet address (0x… 42 characters).", "err"); return; }
    if (window.TURNSTILE_SITE_KEY && window.turnstile && !tsToken()) { say("Please complete the human check first.", "err"); return; }
    submitEl.disabled = true; say("Posting your request…");
    post({ action: "request", address: a, cfTurnstileToken: tsToken() }).then(function (res) {
      submitEl.disabled = false; tsReset();
      if (res.ok && res.status === "already_open") say("You already have an open request. It stays on the board until it's filled.", "ok");
      else if (res.ok) { say("Posted. Your address is on the board for the community to see.", "ok"); addrEl.value = ""; }
      else say(res.error || "Couldn't post that just now.", "err");
      load();
    });
  });

  load();
  setInterval(function () { if (!document.hidden) load(); }, 60000);
})();
