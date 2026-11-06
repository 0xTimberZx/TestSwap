// commands.ts — pure parts of the @TimbSwapTGBot group commands: parsing,
// routing and reply text. No network, no Deno APIs, so it runs under both the
// Supabase Edge runtime (Deno) and `node --test` (commands.test.ts).
//
// Wording rules (dev-docs positioning): "prize draws", "no principal at risk",
// "activity". Never "lottery", "gambling", "mining" or price talk.

// Testnet addresses. Mirror config.js ADDRESSES; commands.test.ts fails when
// they drift, so an address-switch PR has to update both.
export const ADDR = {
  TimbPrize:      "0xDB36B3BC7e68B193D06009aFaFe54678b088088B",
  TimbYieldVault: "0x90B3CF236e0010b81A8F8ceb0F419cfD30443396",
  GasFaucet:      "0x509BcB932D8725D465a59b279234BD4B4C58AdA9",
  TimbStaking:    "0x790741385345D78536A696F7E58e64DDAfa07df6",
  TimbFarm:       "0x093Be67377a6603C77d1BaCb12422E0D53481341",
  TIMBSToken:     "0x1D9016aaAD4Abc30cafA52EEaAfFDbE6f474749D",
} as const;

export const CHAIN_ID = 421614;
export const NET_TAG = "🧪 Testnet";
// Same fixed anchor the site quotes the pot in (config.js ETH_USD_PRICE).
export const ETH_USD = 3000;
export const SITE = "https://timbswap.xyz";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const SEGMENTS = 6;
export const INTERACTION_WINDOW = 59 * 60 + 45; // seconds, TimbPrize.INTERACTION_WINDOW

// Commands the bot answers. "dm" ones touch a wallet or a subscription, so in
// a group the bot only points the user to a DM.
export const COMMANDS: Record<string, { dm: boolean; help: string }> = {
  pot:    { dm: false, help: "prize pot and this round's progress" },
  round:  { dm: false, help: "round, segment and time to the next segment" },
  faucet: { dm: false, help: "gas faucet status" },
  stake:  { dm: false, help: "staking and LP farm emissions" },
  links:  { dm: false, help: "site, docs and bug bounty" },
  help:   { dm: false, help: "this list" },
  rank:   { dm: true,  help: "your Season 1 points: /rank 0xYourWallet" },
  start:  { dm: true,  help: "refund reminders: /start 0xYourWallet" },
  stop:   { dm: true,  help: "turn refund reminders off" },
};

export type Parsed = { cmd: string; arg: string } | null;

/**
 * "/pot", "/pot@TimbSwapTGBot", "/rank 0xabc" → { cmd, arg }. Returns null for
 * plain text, unknown commands and commands addressed to another bot, so in a
 * group the bot stays silent on anything that isn't for it.
 */
export function parseCommand(text: string, botUsername = ""): Parsed {
  const m = /^\/([a-zA-Z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s.exec((text || "").trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const target = m[2];
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  if (!(cmd in COMMANDS)) return null;
  return { cmd, arg: (m[3] || "").trim() };
}

export function isGroup(chatType: string | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

/**
 * What to do with a message: answer a command, point to a DM, show help (a
 * private chat with unknown text) or stay silent (unknown text in a group).
 */
export function route(text: string, chatType: string | undefined, botUsername = ""):
  { kind: "command"; cmd: string; arg: string } | { kind: "dm-only"; cmd: string } | { kind: "help" } | { kind: "silent" } {
  const p = parseCommand(text, botUsername);
  const group = isGroup(chatType);
  if (!p) return group ? { kind: "silent" } : { kind: "help" };
  if (group && COMMANDS[p.cmd].dm) return { kind: "dm-only", cmd: p.cmd };
  return { kind: "command", cmd: p.cmd, arg: p.arg };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** wei (bigint) → decimal string with at most `dp` decimals, trailing zeros trimmed. */
export function fmtUnits(wei: bigint, dp = 4, decimals = 18): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  // Tiny non-zero amounts keep significant digits instead of reading as 0.
  if (whole === 0n && !frac && v > 0n) {
    const full = (v % base).toString().padStart(decimals, "0");
    const firstNz = full.search(/[1-9]/);
    frac = full.slice(0, Math.min(decimals, firstNz + 2)).replace(/0+$/, "");
  }
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}

export function fmtUsd(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  const usd = eth * ETH_USD;
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return "$" + usd.toLocaleString("en-US", { maximumFractionDigits: usd < 10000 ? 2 : 0 });
}

export function fmtDuration(sec: number): string {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)} min`;
}

/** Display window + class pattern: locked/live chars shown, future segments "·". */
export function windowView(counters: bigint[], locked: boolean[], currentWindow: string, segment: number):
  { chars: string; classes: string } {
  let chars = "", classes = "";
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = i + 1;
    if (locked[i] || seg === segment) {
      const raw = locked[i] ? currentWindow[i] : ALPHABET[Number(counters[i] % 36n)];
      const ch = raw && raw !== " " ? raw : "";
      chars += ch || "·";
      classes += ch ? (/[0-9]/.test(ch) ? "D" : "L") : "·";
    } else {
      chars += "·";
      classes += "·";
    }
  }
  return { chars, classes };
}

export type RoundState = {
  round: bigint; segment: bigint; segmentStart: bigint; pot: bigint;
  inSettlement: boolean; currentWindow: string; counters: bigint[]; locked: boolean[];
};

export function roundLines(s: RoundState, nowSec: number): string[] {
  const seg = Number(s.segment);
  if (seg === 0) return ["The game hasn't started yet."];
  const left = Number(s.segmentStart) + INTERACTION_WINDOW - nowSec;
  const v = windowView(s.counters, s.locked, s.currentWindow, seg);
  const timing = s.inSettlement || left <= 0
    ? "segment locking now"
    : seg < SEGMENTS ? `next segment in ${fmtDuration(left)}` : `round settles in ${fmtDuration(left)}`;
  return [
    `Round ${s.round} · segment ${seg} of ${SEGMENTS} · ${timing}`,
    `Scroll: ${v.chars}   (${v.classes}: L letter, D digit)`,
  ];
}

export function potReply(s: RoundState, pendingYield: bigint | null, nowSec: number): string {
  const lines = [
    NET_TAG,
    `🏆 Prize pot: ${fmtUnits(s.pot, 4)} ETH (≈ ${fmtUsd(s.pot)})`,
  ];
  if (pendingYield !== null) lines.push(`Vault yield joining at settlement: +${fmtUnits(pendingYield, 8)} ETH`);
  lines.push(...roundLines(s, nowSec));
  lines.push("No principal at risk: your deposit is yours to claim back within the refund window.");
  lines.push(`${SITE}/compete/`);
  return lines.join("\n");
}

export function roundReply(s: RoundState, nowSec: number): string {
  return [NET_TAG, ...roundLines(s, nowSec), "Swaps on eligible pairs steer the live position.", `${SITE}/compete/`].join("\n");
}

export type FaucetState = {
  ethPaused: boolean; timbsPaused: boolean; dripEth: bigint; potEth: bigint;
  timbsPerClaim: bigint; cooldown: bigint; reserve: bigint; timbsBal: bigint;
};

export function faucetReply(f: FaucetState): string {
  const ethOn = !f.ethPaused && f.reserve >= f.dripEth + f.potEth;
  const timbsOn = !f.timbsPaused && f.timbsBal >= f.timbsPerClaim;
  const lines = [NET_TAG, "⛽ Gas faucet"];
  lines.push(ethOn
    ? `ETH: open · ${fmtUnits(f.dripEth, 6)} ETH to you + ${fmtUnits(f.potEth, 6)} ETH to the pot per claim`
    : `ETH: ${f.ethPaused ? "paused" : "refilling"}`);
  lines.push(timbsOn ? `TIMBS: open · ${fmtUnits(f.timbsPerClaim, 0)} TIMBS per claim` : `TIMBS: ${f.timbsPaused ? "paused" : "refilling"}`);
  lines.push(`One claim per ${fmtDuration(Number(f.cooldown))} for wallets with an active ticket.`);
  lines.push(`Reserve: ${fmtUnits(f.reserve, 4)} ETH · ${fmtUnits(f.timbsBal, 0)} TIMBS`);
  lines.push(`${SITE}/faucet/`);
  return lines.join("\n");
}

export type PoolState = { rate: bigint; total: bigint; finish: bigint };

export function poolLine(name: string, unit: string, p: PoolState, nowSec: number): string {
  const left = Number(p.finish) - nowSec;
  if (left <= 0 || p.rate === 0n) return `${name}: no emissions running`;
  const perDay = p.rate * 86400n;
  const head = `${name}: ${fmtUnits(perDay, 2)} TIMBS/day for ${fmtDuration(left)}`;
  if (p.total === 0n) return `${head}\n  Nobody staked yet: the first staker earns all of it.`;
  return `${head}\n  ${fmtUnits(p.total, 2)} ${unit} staked`;
}

export function stakeReply(staking: PoolState, farm: PoolState, nowSec: number): string {
  return [
    NET_TAG, "🌱 Earn TIMBS",
    poolLine("TIMBS staking", "TIMBS", staking, nowSec),
    poolLine("TIMBS/ETH LP farm", "LP", farm, nowSec),
    "Rewards are shared by stake size; an empty pool's emission is not saved up.",
    `${SITE}/farm/`,
  ].join("\n");
}

export type RankRow = { rank: number; display_tp: number; rounds_played: number; wins: number; flagged?: boolean };

export function rankReply(wallet: string, season: string | null, row: RankRow | null): string {
  if (!season) return "No points season is running right now.";
  const short = wallet.slice(0, 6) + "…" + wallet.slice(-4);
  if (!row) return `${season}: no points yet for ${short}. Play a round or swap to start scoring.\n${SITE}/quests/`;
  if (row.flagged) return `${season}: ${short} is under review. Points show again once the review clears.`;
  return [
    `${season} · ${short}`,
    `Rank #${row.rank} · ${row.display_tp.toLocaleString("en-US")} points`,
    `${row.rounds_played} rounds played · ${row.wins} wins`,
    `${SITE}/quests/`,
  ].join("\n");
}

export function linksReply(): string {
  return [
    "🔗 TimbSwap",
    `Site: ${SITE}`,
    `Prize game: ${SITE}/compete/`,
    `Gas faucet: ${SITE}/faucet/`,
    `Earn TIMBS: ${SITE}/farm/`,
    `Points: ${SITE}/quests/`,
    `Docs: ${SITE}/docs/`,
    `Bug bounty: ${SITE}/bounty/`,
    "X: https://x.com/timbswap",
  ].join("\n");
}

export function helpReply(group: boolean): string {
  const lines = ["TimbSwap bot", ""];
  for (const [c, v] of Object.entries(COMMANDS)) {
    if (group && v.dm) continue;
    lines.push(`/${c} · ${v.help}`);
  }
  if (group) lines.push("", "DM me for /rank and refund reminders.");
  return lines.join("\n");
}

export function dmOnlyReply(cmd: string): string {
  return `/${cmd} works in a private chat with me, so your wallet isn't posted in the group.`;
}

// ─── Cache + rate limit (per isolate, best effort) ───────────────────────────

export class TtlCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  private ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  get(k: string, now: number): T | undefined {
    const e = this.m.get(k);
    return e && now - e.at < this.ttlMs ? e.v : undefined;
  }
  set(k: string, v: T, now: number) {
    this.m.set(k, { at: now, v });
    if (this.m.size > 500) this.m.delete(this.m.keys().next().value as string);
  }
}

/** true when this chat may get another reply to this command now. */
export class RateLimit {
  private m = new Map<string, number>();
  private gapMs: number;
  constructor(gapMs: number) { this.gapMs = gapMs; }
  allow(chat: string, cmd: string, now: number): boolean {
    const k = chat + ":" + cmd;
    const last = this.m.get(k);
    if (last !== undefined && now - last < this.gapMs) return false;
    this.m.set(k, now);
    if (this.m.size > 2000) this.m.delete(this.m.keys().next().value as string);
    return true;
  }
}
