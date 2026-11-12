// settler-revive.js — restart the settler's self-chain when no settler run exists.
//
// Why. The settler (settler.yml) lingers for hours and dispatches its own next
// run only after a run that SUCCEEDED. If a run dies mid-step (runner lost,
// cancelled by GitHub, the Actions API fails the dispatch), no successor is
// queued and the chain stays dead until the */10 cron happens to fire. This
// repo's cron delivers about one tick in four to six, so the game could go
// hours without a settler (5 h 2 min on 10 Nov 2026: the 13:03 run died at
// 18:06 and nobody restarted it). The liveness witness sees the game stall;
// this step, run at the end of each liveness check, closes the loop.
//
// What it does. Reads the settler's runs from the Actions API. If NO settler
// run is in progress, queued, pending or waiting, and the latest one ended
// more than a few minutes ago, it dispatches settler.yml once and says so on
// Telegram (♻️, so it also reaches the critical bot). It does not touch
// settler state, the settler key, a contract, or any other job.
//
// What it will NOT do (each logged, none an error):
//   disabled    SETTLER_REVIVE=off. The kill switch for planned maintenance.
//   active      a settler run exists; that is the chain, leave it alone.
//   just-ended  the latest run ended under SETTLER_REVIVE_GRACE_MIN ago (default
//               3); its own dispatch may still be landing.
//   cancelled   the latest run was cancelled. A person cancelling the settler
//               is a deliberate stop; the liveness witness still alerts if the
//               game stalls, and the next manual dispatch restarts it.
//   crash-loop  SETTLER_REVIVE_MAX_FAILURES (default 3) runs failed within the
//               last hour; restarting a settler that dies at once helps no one.
//               The liveness `stuck` finding and the heartbeat carry the alert.
//   no-history  the API shows no settler runs at all.
//
// Two settlers on one key would race on one nonce stream. This cannot start a
// second one: it dispatches only when none is active, and settler.yml's
// concurrency group (cancel-in-progress: false) queues rather than overlaps.
//
// This is a narrow exception to KEEPER_FLEET.md rule 1 (witnesses do not
// dispatch other jobs); see §4 there. Stateless: nothing is read from or
// written to any state file.
//
// Env:
//   GITHUB_TOKEN, GITHUB_REPOSITORY   Actions-provided (actions: read)
//   DISPATCH_TOKEN                    fine-grained PAT with Actions read/write
//                                     (same fallback chain as the self-chains)
//   SETTLER_REVIVE                    "off" disables
//   SETTLER_REVIVE_GRACE_MIN, SETTLER_REVIVE_MAX_FAILURES
//   TELEGRAM_*                        optional ops alerts (lib/telegram.js)
//
// Flags: --self-test  --dry-run (decide and log; dispatch and send nothing)

"use strict";

const fs = require("fs");
const { opsTelegram } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");

const WORKFLOW = "settler.yml";
const ACTIVE   = new Set(["in_progress", "queued", "pending", "waiting", "requested"]);
const FAILED   = new Set(["failure", "timed_out"]);

const OPTS = {
  disabled:      String(process.env.SETTLER_REVIVE || "").trim().toLowerCase() === "off",
  graceMin:      Number(process.env.SETTLER_REVIVE_GRACE_MIN || 3),
  maxFailures:   Number(process.env.SETTLER_REVIVE_MAX_FAILURES || 3),
  failWindowMin: 60,
};

// ─── Pure decision (exported for --self-test) ───────────────────────────────

/**
 * runs: [{ id, status, conclusion, created_at, updated_at }] from the API, any
 * order. Returns { action: "revive" | "skip", why, detail }.
 */
function decide(runs, nowMs, o = OPTS) {
  if (o.disabled) return { action: "skip", why: "disabled", detail: "SETTLER_REVIVE=off" };
  if (!runs.length) return { action: "skip", why: "no-history", detail: "no settler runs in the API: nothing to restart" };

  const active = runs.find((r) => ACTIVE.has(r.status));
  if (active) return { action: "skip", why: "active", detail: `settler run ${active.id} is ${active.status}` };

  const latest = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const endedMin = (nowMs - Date.parse(latest.updated_at)) / 60_000;
  if (endedMin < o.graceMin) {
    return { action: "skip", why: "just-ended", detail: `latest run ${latest.id} ended ${Math.round(endedMin * 10) / 10} min ago` };
  }
  if (latest.conclusion === "cancelled") {
    return { action: "skip", why: "cancelled", detail: `latest run ${latest.id} was cancelled: treated as a deliberate stop` };
  }

  const failures = runs.filter((r) => FAILED.has(r.conclusion) && (nowMs - Date.parse(r.updated_at)) / 60_000 <= o.failWindowMin).length;
  if (failures >= o.maxFailures) {
    return { action: "skip", why: "crash-loop", detail: `${failures} settler runs failed in the last ${o.failWindowMin} min` };
  }

  return {
    action: "revive", why: "dead-chain",
    detail: `no settler run is active; latest ${latest.id} ${latest.conclusion || latest.status} ${Math.round(endedMin)} min ago`,
    latestId: latest.id,
  };
}

module.exports = { decide, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  const now = Date.parse("2026-11-10T18:30:00Z");
  const iso = (m) => new Date(now - m * 60_000).toISOString();
  // A completed run created `c` min ago that ended `e` min ago.
  const done = (id, c, e, conclusion = "success") => ({ id, status: "completed", conclusion, created_at: iso(c), updated_at: iso(e) });
  const live = (id, c, status = "in_progress") => ({ id, status, conclusion: null, created_at: iso(c), updated_at: iso(c) });
  const o = { disabled: false, graceMin: 3, maxFailures: 3, failWindowMin: 60 };
  const why = (runs, opt = o) => { const d = decide(runs, now, opt); return [d.action, d.why]; };

  eq("kill switch",                 why([done(1, 400, 25, "failure")], { ...o, disabled: true }), ["skip", "disabled"]);
  eq("no runs at all",              why([]), ["skip", "no-history"]);
  eq("in progress is the chain",    why([live(2, 120), done(1, 400, 130)]), ["skip", "active"]);
  eq("queued is the chain",         why([live(2, 1, "queued"), done(1, 400, 5)]), ["skip", "active"]);
  eq("pending is the chain",        why([live(2, 1, "pending"), done(1, 400, 5)]), ["skip", "active"]);
  eq("10 Nov 2026: died, nothing after", why([done(3533, 330, 24, "failure"), done(3532, 700, 330, "cancelled"), done(3531, 600, 330)]), ["revive", "dead-chain"]);
  eq("ended a minute ago waits",    why([done(1, 400, 1, "failure")]), ["skip", "just-ended"]);
  eq("ended past the grace revives", why([done(1, 400, 4, "failure")]), ["revive", "dead-chain"]);
  eq("latest cancelled is deliberate", why([done(2, 300, 30, "cancelled"), done(1, 600, 310)]), ["skip", "cancelled"]);
  eq("older cancel, newer failure revives", why([done(2, 100, 20, "failure"), done(1, 300, 120, "cancelled")]), ["revive", "dead-chain"]);
  eq("success with no successor revives", why([done(1, 400, 20, "success")]), ["revive", "dead-chain"]);
  eq("timed out revives",           why([done(1, 400, 20, "timed_out")]), ["revive", "dead-chain"]);
  eq("3 failures in the hour is a loop", why([done(3, 50, 40, "failure"), done(2, 80, 55, "failure"), done(1, 110, 58, "failure")]), ["skip", "crash-loop"]);
  eq("timeouts count toward the loop", why([done(3, 50, 40, "timed_out"), done(2, 80, 55, "timed_out"), done(1, 110, 58, "failure")]), ["skip", "crash-loop"]);
  eq("old failures do not count",  why([done(3, 50, 40, "failure"), done(2, 300, 200, "failure"), done(1, 400, 300, "failure")]), ["revive", "dead-chain"]);
  eq("input order does not matter", why([done(1, 400, 130, "failure"), done(2, 100, 20, "failure")]), ["revive", "dead-chain"]);
  eq("picks the newest run",        decide([done(1, 400, 130, "failure"), done(2, 100, 20, "failure")], now, o).latestId, 2);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST && require.main === module) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "timbswap-settler-revive",
});

async function fetchRuns(repo, token) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=30`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`${WORKFLOW} runs: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.workflow_runs || []).map((r) => ({
    id: r.id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, updated_at: r.updated_at, url: r.html_url,
  }));
}

// A dispatch is one POST. Transient API errors (the 500 that broke the
// solvency watch's chain on 5 Nov) get a few retries; anything else fails at once.
async function dispatch(repo, token) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`;
  let last;
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(15_000);
    try {
      const res = await fetch(url, { method: "POST", headers: headers(token), body: JSON.stringify({ ref: "main" }) });
      if (res.status === 204) return;
      last = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429 && res.status !== 408) break;
    } catch (e) { last = e; }
  }
  throw last;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const tg = opsTelegram({ mode: process.env.TELEGRAM_OPS_MODE, tag: "settler-revive" });
  const nowMs = Date.now();

  const runs = await fetchRuns(repo, token);
  const d = decide(runs, nowMs);
  console.log(`settler-revive @ ${new Date(nowMs).toISOString()}  ${d.action}: ${d.why} (${d.detail})`);
  if (d.action === "skip") return;

  const pat = process.env.DISPATCH_TOKEN;
  if (!pat) throw new Error("the settler chain is dead but no DISPATCH_TOKEN secret is set (LIVENESS_/FAUCET_/SETTLER_DISPATCH_TOKEN): start it by hand");
  if (DRY_RUN) { console.log("(dry run) would dispatch settler.yml"); return; }

  try {
    await dispatch(repo, pat);
  } catch (e) {
    await tg.send(`⚠️ Settler revive FAILED: ${e.message}\nThe settler chain is dead. Start it by hand: Actions → TimbSwap Settler → Run workflow.`);
    throw e;
  }

  await sleep(20_000);
  let seen = null;
  try { seen = (await fetchRuns(repo, token)).find((r) => ACTIVE.has(r.status)) || null; } catch { /* the dispatch itself succeeded */ }
  const link = seen ? `\n${seen.url}` : "\n(dispatch accepted; the run was not visible yet)";
  console.log(`  dispatched settler.yml${seen ? `: run ${seen.id} is ${seen.status}` : ""}`);
  await tg.send(`♻️ Settler revived: ${d.detail}.\nStarted a new settler run.${link}`);
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(`::error::${e.message || e}`); process.exit(2); });
