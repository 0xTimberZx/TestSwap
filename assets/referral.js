// referral.js — season referral card (on /quests) and the referral confirm
// banner (on /compete and /quests).
//
// How it works (rules in supabase/functions/referrals and the referrals migration):
//   * config.js keeps the ?r=CODE a visitor arrived with (first touch, 30 days).
//   * After that visitor's first ticket, #ref-bind asks them to confirm the code
//     with a free signature. It counts once they've played 5 rounds this season.
//   * A wallet on the season board sees #qs-ref: its code, QR, tier (D 1, C 3,
//     B 9, A 36, S 180 qualified wallets), a share image and ready-made posts.
//     Credit pauses while the referrer's ticket isn't Active.
// config.js declares `let userAddress` / `let signer` at the top level of a
// classic script: global bindings, not window properties, so they are read by name.
(function () {
  "use strict";
  var API = "/api/referrals";
  var bindEl = document.getElementById("ref-bind");
  var cardEl = document.getElementById("qs-ref");
  if (!bindEl && !cardEl) return;

  var REF_KEY = "timbswap_ref";
  var DONE_PREFIX = "timbswap_ref_done_";
  var ROOT = (typeof SITE_ROOT !== "undefined" && SITE_ROOT) ? SITE_ROOT : "/";   // config.js top-level const
  var QRLIB = ROOT + "vendor/qrcode.js?v=" + (window.ASSET_VER || "1");
  var MAINNET = typeof NET_IS_MAINNET !== "undefined" && NET_IS_MAINNET;

  function addr() { try { if (typeof userAddress !== "undefined" && userAddress) return String(userAddress).toLowerCase(); } catch (e) {} return null; }
  function wallet() { try { if (typeof signer !== "undefined" && signer) return signer; } catch (e) {} return null; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function storedRef() { try { var r = JSON.parse(lsGet(REF_KEY) || "null"); return r && r.code ? r : null; } catch (e) { return null; } }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function num(n) { return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function post(body) {
    return fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; });
  }

  (function style() {
    var css = ""
      + ".ref-box{margin:16px 0;padding:16px;border-radius:var(--radius,12px);border:var(--bw,1px) solid var(--border,#24322b);background:var(--bg2,#111714);color:var(--text,#e8f0ec);font-size:14px;line-height:1.5}"
      + ".ref-box .ref-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}"
      + ".ref-btn{min-height:40px;padding:0 14px;border-radius:var(--radius,10px);border:var(--bw,1px) solid var(--border,#24322b);background:transparent;color:var(--text,#e8f0ec);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}"
      + ".ref-btn.primary{background:var(--green,#14f195);color:#062015;border-color:transparent}"
      + ".ref-btn[disabled]{opacity:.6;cursor:default}"
      + ".ref-msg{margin-top:8px;font-size:13px;color:var(--text-2,#9fb2a8)}.ref-msg.ok{color:var(--green,#14f195)}.ref-msg.err{color:#ff7a7a}"
      + ".ref-head{display:flex;align-items:center;justify-content:space-between;gap:8px}"
      + ".ref-title{font-weight:700;font-size:16px}"
      + ".ref-tier{font-family:var(--mono,monospace);font-size:12px;letter-spacing:1px;padding:3px 10px;border-radius:999px;border:var(--bw,1px) solid rgba(20,241,149,.45);color:var(--green,#14f195)}"
      + ".ref-bar{height:6px;border-radius:3px;background:var(--border,#24322b);margin:8px 0 4px;overflow:hidden}.ref-bar>i{display:block;height:100%;background:var(--green,#14f195)}"
      + ".ref-sub{font-size:13px;color:var(--text-2,#9fb2a8)}"
      + ".ref-paused{margin-top:10px;font-size:13px;color:#f3c969}"
      + ".ref-code-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}"
      + ".ref-label{font-family:var(--mono,monospace);font-size:11px;letter-spacing:1px;color:var(--text-3,#7d8f86);text-transform:uppercase}"
      + ".ref-code{font-family:var(--mono,monospace);font-size:26px;letter-spacing:3px;font-weight:700}"
      + ".ref-qr{width:112px;height:112px;flex:0 0 112px;background:#fff;border-radius:8px;overflow:hidden}.ref-qr svg{width:100%;height:100%;display:block}"
      + ".ref-hint{margin:12px 0 0;font-size:12.5px;color:var(--text-3,#7d8f86)}";
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
  })();

  // ── Confirm banner ─────────────────────────────────────────────────────────
  var bindFor = null;
  function hideBind() { if (bindEl) { bindEl.hidden = true; bindEl.innerHTML = ""; } }
  function checkBind(a) {
    if (!bindEl) return;
    var ref = storedRef();
    if (!a || !ref || lsGet(DONE_PREFIX + a)) { hideBind(); return; }
    if (bindFor === a + ref.code) return;
    post({ action: "status", address: a }).then(function (res) {
      if (addr() !== a) return;
      if (!res || !res.ok || !res.season) { hideBind(); return; }
      if (res.bound) { lsSet(DONE_PREFIX + a, "bound"); hideBind(); return; }
      if (!res.bindable) { hideBind(); return; }   // no ticket yet: ask after the first one
      bindFor = a + ref.code;
      renderBind(a, ref.code, res.season);
    });
  }
  function renderBind(a, code, season) {
    bindEl.hidden = false;
    bindEl.innerHTML = '<div class="ref-box">'
      + '<div><strong>Referral code ' + esc(code) + '</strong>: confirm it with a free signature (no gas). '
      + 'It counts once you\'ve played 5 rounds this season.</div>'
      + '<div class="ref-row"><button type="button" class="ref-btn primary" id="ref-bind-ok">Confirm referral</button>'
      + '<button type="button" class="ref-btn" id="ref-bind-no">Not now</button></div>'
      + '<div class="ref-msg" id="ref-bind-msg" role="status" aria-live="polite"></div></div>';
    var ok = document.getElementById("ref-bind-ok"), no = document.getElementById("ref-bind-no"), msg = document.getElementById("ref-bind-msg");
    function say(t, k) { msg.textContent = t; msg.className = "ref-msg" + (k ? " " + k : ""); }
    no.addEventListener("click", function () { lsSet(DONE_PREFIX + a, "dismissed"); hideBind(); });
    ok.addEventListener("click", function () {
      var w = wallet();
      if (!w || addr() !== a) { say("Connect the wallet that holds your ticket first.", "err"); return; }
      var issued = new Date().toISOString();
      var text = ["TimbSwap referral", "Code: " + code, "Wallet: " + a, "Season: " + season.slug, "Issued: " + issued].join("\n");
      ok.disabled = true; say("Check your wallet to sign…");
      Promise.resolve().then(function () { return w.signMessage(text); }).then(function (sig) {
        say("Confirming…");
        return post({ action: "bind", address: a, code: code, issued: issued, signature: sig });
      }).then(function (res) {
        ok.disabled = false;
        if (!res) return;
        var final = res.result && res.result !== "error";
        say(res.message || res.error || "Couldn't confirm just now.", res.ok ? "ok" : "err");
        if (final) { lsSet(DONE_PREFIX + a, res.result); ok.hidden = true; no.textContent = "Close"; }
      }).catch(function (e) {
        ok.disabled = false;
        say(e && (e.code === 4001 || e.code === "ACTION_REJECTED") ? "Signature cancelled." : "Couldn't confirm just now.", "err");
      });
    });
  }

  // ── Season card ────────────────────────────────────────────────────────────
  var card = null, cardFor = null;
  function checkCard(a) {
    if (!cardEl) return;
    if (!a) { cardEl.hidden = true; cardEl.innerHTML = ""; card = null; cardFor = null; return; }
    post({ action: "card", address: a }).then(function (res) {
      if (addr() !== a) return;
      if (!res || !res.ok || !res.season) { cardEl.hidden = true; return; }
      if (!res.eligible) {
        cardEl.hidden = false;
        cardEl.innerHTML = '<div class="ref-box"><div class="ref-title">Your season card</div>'
          + '<div class="ref-sub">Your card and referral code unlock once this wallet is on the ' + esc(res.season.name) + ' board.</div></div>';
        return;
      }
      card = res; cardFor = a; renderCard(res);
    });
  }
  function renderCard(c) {
    var r = c.referrals || {};
    var tierTxt = c.tier ? "Tier " + c.tier : "No tier yet";
    var nxt = c.next ? (c.next.need + " more to " + c.next.tier) : "Top tier reached";
    var base = c.tier ? ({ D: 1, C: 3, B: 9, A: 36, S: 180 })[c.tier] : 0;
    var top = c.next ? base + c.next.need : base;
    var pct = c.next ? Math.round(100 * (r.qualified - base) / Math.max(1, top - base)) : 100;
    var waiting = [];
    if (r.pending) waiting.push(r.pending + " playing toward 5 rounds");
    if (r.held) waiting.push(r.held + " waiting for your ticket");
    if (r.capped) waiting.push(r.capped + " not counted (network limit)");
    cardEl.hidden = false;
    cardEl.innerHTML = '<div class="ref-box">'
      + '<div class="ref-head"><span class="ref-title">Your season card</span><span class="ref-tier">' + esc(tierTxt) + '</span></div>'
      + '<div class="ref-sub">' + esc(c.season.name) + (c.rank ? ' · rank #' + esc(c.rank) : '') + ' · ' + num(c.display_tp) + ' TP</div>'
      + '<div class="ref-bar"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>'
      + '<div class="ref-sub">' + esc(r.qualified || 0) + ' qualified referral' + (r.qualified === 1 ? '' : 's') + ' · ' + esc(nxt) + '</div>'
      + (waiting.length ? '<div class="ref-sub">' + esc(waiting.join(" · ")) + '</div>' : '')
      + (c.paused ? '<div class="ref-paused">Credit is paused while your ticket isn\'t active. Referrals keep playing and are credited once it\'s active again.</div>' : '')
      + '<div class="ref-code-row"><div><div class="ref-label">Your code</div><div class="ref-code">' + esc(c.code) + '</div></div>'
      + '<div class="ref-qr" id="ref-qr" aria-label="QR code for your referral link"></div></div>'
      + '<div class="ref-row">'
      + '<button type="button" class="ref-btn" id="ref-copy">Copy link</button>'
      + '<button type="button" class="ref-btn primary" id="ref-share">Share image</button>'
      + '<a class="ref-btn" id="ref-x" target="_blank" rel="noopener">Post on X</a>'
      + '<a class="ref-btn" id="ref-tg" target="_blank" rel="noopener">Post on Telegram</a></div>'
      + '<div class="ref-msg" id="ref-card-msg" role="status" aria-live="polite"></div>'
      + '<p class="ref-hint">A referral counts when a new player confirms your code after their first ticket and plays 5 rounds. '
      + 'Up to 3 per network. Tiers: D 1 · C 3 · B 9 · A 36 · S 180. The code is yours for this season.</p></div>';
    var msg = document.getElementById("ref-card-msg");
    function say(t, k) { msg.textContent = t; msg.className = "ref-msg" + (k ? " " + k : ""); }
    var text = postText(c);
    document.getElementById("ref-x").href = "https://x.com/intent/post?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(c.link);
    document.getElementById("ref-tg").href = "https://t.me/share/url?url=" + encodeURIComponent(c.link) + "&text=" + encodeURIComponent(text);
    document.getElementById("ref-copy").addEventListener("click", function () {
      try { navigator.clipboard.writeText(c.link).then(function () { say("Link copied.", "ok"); }, function () { say(c.link); }); } catch (e) { say(c.link); }
    });
    document.getElementById("ref-share").addEventListener("click", function () { shareImage(c, text, say); });
    qr(c.link).then(function (q) { var box = document.getElementById("ref-qr"); if (box && q) box.innerHTML = q.svg; });
  }
  function postText(c) {
    var lead = c.season.name + (c.rank ? " · rank #" + c.rank : "") + " on the TimbSwap board.";
    return lead + (MAINNET
      ? " Capped beta on Arbitrum One: call six characters, trade, and see if the meter lands on them."
      : " Free on testnet: call six characters, trade, and see if the meter lands on them.");
  }

  // QR as SVG markup plus its path, so the share image can draw it without
  // loading an SVG into the canvas.
  var qrCache = {};
  function qr(text) {
    if (qrCache[text]) return qrCache[text];
    qrCache[text] = import(QRLIB).then(function (m) {
      var svg = m.qrSvg(text, 4, 8);
      var vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg), d = /<path[^>]* d="([^"]+)"/.exec(svg);
      return { svg: svg, size: vb ? Number(vb[1]) : 0, d: d ? d[1] : "" };
    }).catch(function () { return null; });
    return qrCache[text];
  }

  // ── Share image (stock art + stats; never the ticket) ──────────────────────
  function shareImage(c, text, say) {
    say("Making your image…");
    Promise.all([qr(c.link), (document.fonts && document.fonts.ready) || Promise.resolve()]).then(function (res) {
      var q = res[0];
      var cv = drawCard(c, q);
      cv.toBlob(function (blob) {
        if (!blob) { say("Couldn't make the image.", "err"); return; }
        var name = "timbswap-" + c.code.toLowerCase() + ".png";
        var file = null;
        try { file = new File([blob], name, { type: "image/png" }); } catch (e) {}
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], text: text + " " + c.link }).then(function () { say(""); }, function () { say(""); });
          return;
        }
        var url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        say("Image downloaded.", "ok");
      }, "image/png");
    });
  }
  function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) { var t = Math.PI / 3 * i - Math.PI / 2; ctx[i ? "lineTo" : "moveTo"](cx + r * Math.cos(t), cy + r * Math.sin(t)); }
    ctx.closePath();
  }
  function drawCard(c, q) {
    var W = 1080, cv = document.createElement("canvas"); cv.width = W; cv.height = W;
    var x = cv.getContext("2d");
    var SANS = "'Space Grotesk', system-ui, sans-serif", MONO = "'Space Mono', ui-monospace, monospace";
    var g = x.createLinearGradient(0, 0, W, W); g.addColorStop(0, "#0b0f0d"); g.addColorStop(1, "#0c2a1f");
    x.fillStyle = g; x.fillRect(0, 0, W, W);
    // stock art: faint hexagons
    x.lineWidth = 3;
    [[900, 170, 260, .07], [1010, 520, 150, .05], [760, 360, 90, .06], [140, 900, 210, .04]].forEach(function (h) {
      x.strokeStyle = "rgba(20,241,149," + h[3] + ")"; hexPath(x, h[0], h[1], h[2]); x.stroke();
    });
    // wordmark
    x.strokeStyle = "#14f195"; x.lineWidth = 7; hexPath(x, 116, 126, 38); x.stroke();
    x.fillStyle = "#e8f0ec"; x.font = "700 60px " + SANS; x.textBaseline = "middle"; x.fillText("TimbSwap", 176, 128);
    x.fillStyle = "#14f195"; x.font = "400 30px " + MONO; x.fillText(c.season.name.toUpperCase(), 80, 230);
    // headline
    x.fillStyle = "#ffffff"; x.font = "700 128px " + SANS; x.textBaseline = "alphabetic";
    x.fillText(c.rank ? "Rank #" + c.rank : "On the board", 76, 380);
    // stats
    var stats = [[num(c.display_tp), "TIMBER POINTS"], [String(c.rounds_played || 0), "ROUNDS"], [String(c.best_streak || 0), "BEST STREAK"]];
    stats.forEach(function (s, i) {
      var sx = 80 + i * 320;
      x.fillStyle = "#e8f0ec"; x.font = "700 64px " + SANS; x.fillText(s[0], sx, 500);
      x.fillStyle = "#7d8f86"; x.font = "400 24px " + MONO; x.fillText(s[1], sx, 544);
    });
    if (c.tier) {
      x.strokeStyle = "rgba(20,241,149,.6)"; x.lineWidth = 3;
      x.beginPath(); if (x.roundRect) x.roundRect(80, 590, 300, 64, 32); else x.rect(80, 590, 300, 64); x.stroke();
      x.fillStyle = "#14f195"; x.font = "700 30px " + MONO; x.fillText("REFERRALS · " + c.tier, 112, 633);
    }
    // QR
    var qs = 300, qx = W - 80 - qs, qy = W - 80 - qs;
    x.fillStyle = "#ffffff"; x.beginPath(); if (x.roundRect) x.roundRect(qx, qy, qs, qs, 20); else x.rect(qx, qy, qs, qs); x.fill();
    if (q && q.d && q.size && window.Path2D) {
      x.save(); x.translate(qx + 10, qy + 10); x.scale((qs - 20) / q.size, (qs - 20) / q.size);
      x.fillStyle = "#000000"; x.fill(new Path2D(q.d)); x.restore();
    }
    // code + link
    x.fillStyle = "#7d8f86"; x.font = "400 26px " + MONO; x.fillText("JOIN WITH CODE", 80, 812);
    x.fillStyle = "#ffffff"; x.font = "700 84px " + MONO; x.fillText(c.code, 76, 900);
    x.fillStyle = "#9fb2a8"; x.font = "400 28px " + MONO; x.fillText("timbswap.xyz/?r=" + c.code, 80, 950);
    x.fillStyle = "#5f6f67"; x.font = "400 24px " + SANS;
    x.fillText(MAINNET ? "Capped beta on Arbitrum One" : "Free on Arbitrum Sepolia testnet", 80, 1000);
    return cv;
  }

  // ── Wallet watch ───────────────────────────────────────────────────────────
  var last = undefined;
  function tick() {
    var a = addr();
    if (a !== last) { last = a; bindFor = null; checkBind(a); checkCard(a); }
  }
  tick();
  setInterval(tick, 3000);
  // The banner waits for the first ticket, so look again every minute; the card every 5.
  setInterval(function () { var a = addr(); if (a && storedRef() && !lsGet(DONE_PREFIX + a)) { bindFor = null; checkBind(a); } }, 60000);
  setInterval(function () { var a = addr(); if (a && cardFor === a) checkCard(a); }, 300000);
})();
