// lib/telegram.js — ops alerts, best-effort.
//
// A Telegram failure must never fail a keeper: every send swallows its own
// errors and logs them. Two conventions the fleet already follows are encoded
// here so a new keeper cannot get them subtly wrong:
//
//   • Markdown is retried as plain text. Error dumps contain `_ * [ ]` which
//     break Markdown parsing, and a dropped alert is exactly the alert you
//     needed (an RPC 403 once went unnoticed this way).
//   • The ops-mode switch (TELEGRAM_OPS_MODE): "all" sends everything,
//     "errors" only lines that open with an alert glyph, "off" nothing. It
//     never affects a community stream, which is a separate chat id.
//
// Ops destinations (opsTelegram). Each can be its own bot, because on Actions
// every keeper shares one TELEGRAM_BOT_TOKEN, and that bot also DMs reminder
// subscribers:
//   team console   TELEGRAM_OPS_BOT_TOKEN / TELEGRAM_OPS_CHAT_ID, falling back
//                  to TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Every ops message,
//                  subject to the ops-mode switch.
//   critical       TELEGRAM_CRITICAL_BOT_TOKEN / TELEGRAM_CRITICAL_CHAT_ID,
//                  optional. Only messages with an alert glyph at the start of
//                  any line (failures, delays, recoveries), whatever the mode.
//                  TELEGRAM_CRITICAL_MODE=all mirrors every ops message there
//                  instead; a workflow sets it per keeper (the settler does, so
//                  segment beats reach the phone too).

const ALERT_GLYPH = /^[❌⚠️💥♻️🚨]/u;
// Same glyphs, at the start of any line: keepers prepend a header line
// ("🔄 *TimbSwap Settler*") before the alert itself.
const CRITICAL_LINE = /^\s*[❌⚠💥♻🚨]/mu;

/**
 * makeTelegram({ token, chatId, mode, tag, preview }) → { enabled, mode, send, notify }
 *   send(text, { markdown })  always sends (mode "off" still suppresses)
 *   notify(text)              honours mode "errors": routine beats are dropped
 * `tag` prefixes log lines so several keepers' output stays attributable.
 * `preview` keeps link previews (off by default: ops alerts carry tx links
 * and error dumps; a community stream that links the site wants them on).
 */
function makeTelegram({ token, chatId, mode = "all", tag = "tg", preview = false } = {}) {
  const m = String(mode || "all").toLowerCase();
  const enabled = Boolean(token && chatId) && m !== "off";
  const url = token ? `https://api.telegram.org/bot${token}/sendMessage` : null;

  async function post(body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: !preview, ...body }),
    });
  }

  async function send(text, { markdown = false } = {}) {
    if (!enabled) return false;
    try {
      let res = await post(markdown ? { text, parse_mode: "Markdown" } : { text });
      if (!res.ok && markdown) {
        console.error(`[${tag}] Markdown send failed, retrying plain text:`, await res.text());
        res = await post({ text });
      }
      if (!res.ok) { console.error(`[${tag}] send error:`, await res.text()); return false; }
      return true;
    } catch (e) {
      console.error(`[${tag}] send failed (non-fatal):`, e.message);
      return false;
    }
  }

  async function notify(text, opts) {
    if (m === "errors" && !ALERT_GLYPH.test(text)) return false;
    return send(text, opts);
  }

  return { enabled, mode: m, send, notify };
}

/** True when a message carries an alert glyph at the start of any line. */
function isCritical(text) {
  return CRITICAL_LINE.test(String(text || ""));
}

/**
 * opsTelegram({ mode, tag, env }) → { enabled, mode, send, notify }
 * The keepers' ops channel: the team console (every message, ops-mode
 * applies) plus, when configured, a critical-only mirror (see the header).
 * Same interface as makeTelegram, so a keeper swaps one for the other.
 */
function opsTelegram({ mode, tag = "ops", env = process.env } = {}) {
  const team = makeTelegram({
    token:  env.TELEGRAM_OPS_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_OPS_CHAT_ID   || env.TELEGRAM_CHAT_ID,
    mode, tag,
  });
  const critical = makeTelegram({
    token: env.TELEGRAM_CRITICAL_BOT_TOKEN, chatId: env.TELEGRAM_CRITICAL_CHAT_ID,
    mode: "all", tag: `${tag}-critical`,
  });
  const mirrorAll = String(env.TELEGRAM_CRITICAL_MODE || "").toLowerCase() === "all";
  const mirror = (text, opts) =>
    (critical.enabled && (mirrorAll || isCritical(text)) ? critical.send(text, opts) : false);

  async function send(text, opts) {
    const [sent] = await Promise.all([team.send(text, opts), mirror(text, opts)]);
    return sent;
  }
  async function notify(text, opts) {
    const [sent] = await Promise.all([team.notify(text, opts), mirror(text, opts)]);
    return sent;
  }
  return { enabled: team.enabled || critical.enabled, mode: team.mode, send, notify };
}

/**
 * Re-alert throttle: true when no alert has been sent for this key, or the last
 * one is older than `intervalSec`. Witnesses use it so a keeper that stays
 * stuck produces one message per interval, not one per run.
 */
function shouldRealert(lastAlertedAtSec, nowSec, intervalSec) {
  if (!lastAlertedAtSec) return true;
  return nowSec - lastAlertedAtSec >= intervalSec;
}

module.exports = { ALERT_GLYPH, isCritical, makeTelegram, opsTelegram, shouldRealert };

// ── Self-test: node lib/telegram.js --self-test (fetch is stubbed; nothing is sent) ──
if (require.main === module && process.argv.includes("--self-test")) {
  (async () => {
    let pass = 0, fail = 0;
    const ok = (name, cond) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };
    const sent = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ bot: url.split("/bot")[1].split("/")[0], chat: body.chat_id, text: body.text });
      return { ok: true, text: async () => "" };
    };
    const env = {
      TELEGRAM_BOT_TOKEN: "alerts", TELEGRAM_CHAT_ID: "1",
      TELEGRAM_OPS_BOT_TOKEN: "psa", TELEGRAM_OPS_CHAT_ID: "team",
      TELEGRAM_CRITICAL_BOT_TOKEN: "debug", TELEGRAM_CRITICAL_CHAT_ID: "me",
    };
    const to = () => sent.map((x) => `${x.bot}:${x.chat}`).sort().join(",");

    ok("isCritical on line 1", isCritical("💥 boom"));
    ok("isCritical after a header", isCritical("🔄 *TimbSwap Settler*\n💥 Settler fatal error"));
    ok("isCritical warning sign", isCritical("hdr\n⚠️ Round 12 is late"));
    ok("routine is not critical", !isCritical("🔄 *TimbSwap Settler*\n🔒 Locked segment 2/6"));

    let t = opsTelegram({ env, tag: "t" });
    sent.length = 0; await t.send("🔄 hdr\n🔒 locked");
    ok("routine: team console only", to() === "psa:team");
    sent.length = 0; await t.send("🔄 hdr\n💥 fatal");
    ok("critical: team console and phone", to() === "debug:me,psa:team");

    t = opsTelegram({ env: { ...env, TELEGRAM_CRITICAL_MODE: "all" }, tag: "t" });
    sent.length = 0; await t.send("🔄 hdr\n✅ Segment 3/6 settled");
    ok("critical mode all: routine reaches the phone too", to() === "debug:me,psa:team");
    t = opsTelegram({ env: { ...env, TELEGRAM_CRITICAL_MODE: "ALL" }, mode: "off", tag: "t" });
    sent.length = 0; await t.send("🔄 hdr\n✅ Segment 3/6 settled");
    ok("critical mode all, ops off: phone only", to() === "debug:me");

    t = opsTelegram({ env, mode: "errors", tag: "t" });
    sent.length = 0; await t.notify("🎯 Sent 3 DMs");
    ok("errors mode drops a routine notify", to() === "");
    sent.length = 0; await t.notify("💥 pass failed");
    ok("errors mode still sends a critical notify to both", to() === "debug:me,psa:team");

    t = opsTelegram({ env, mode: "off", tag: "t" });
    sent.length = 0; await t.send("💥 fatal");
    ok("ops off: phone still gets critical", to() === "debug:me");

    t = opsTelegram({ env: { TELEGRAM_BOT_TOKEN: "alerts", TELEGRAM_CHAT_ID: "1" }, tag: "t" });
    sent.length = 0; await t.send("💥 fatal");
    ok("no new secrets: unchanged (shared bot, ops chat)", to() === "alerts:1");

    t = opsTelegram({ env: {}, tag: "t" });
    ok("nothing configured: disabled", !t.enabled);

    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
