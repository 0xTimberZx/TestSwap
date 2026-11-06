// TimbSwap Telegram bot webhook (Supabase Edge Function, Deno), @TimbSwapTGBot.
//
// Two jobs:
//
// 1. Reclaim reminders (private chat only).
//    Frontend "Remind me on Telegram" → https://t.me/<bot>?start=<wallet>
//    Telegram delivers "/start <wallet>" here → we upsert the wallet↔chat_id
//    link. The worker (scripts/reclaim-reminder.js) later DMs that chat before
//    the wallet's §14 refund window lapses. /stop unsubscribes.
//    The link is self-declared (a wallet address is public; the worst case is
//    someone subscribing to a public address's already-public expiry timing).
//
// 2. Read-only commands for the community group and DMs:
//      /pot /round /faucet /stake /links /help   anywhere
//      /rank <0x…>                               private chat only
//    Contract reads over JSON-RPC, Season points from the points tables. No
//    writes on-chain, no keys. Parsing, routing and reply text live in
//    commands.ts (pure, tested with `node --test`).
//
// Group behaviour: keep Telegram privacy mode ON (BotFather default) so the bot
// only receives commands. In a group the bot answers only its own commands and
// stays silent on anything else; wallet commands (/start, /stop, /rank) reply
// with a pointer to a DM so nobody posts their wallet in the group.
// Each command's answer is cached 30 s (ten people typing /pot cost one read),
// and a chat gets at most one reply per command per 10 s.
//
// Security: Telegram is told a secret token at setWebhook time and echoes it in
// the X-Telegram-Bot-Api-Secret-Token header on every delivery; we reject any
// request without the matching secret, so only Telegram can drive this.
//
// Secrets (Supabase → Project Settings → Edge Functions):
//   TELEGRAM_BOT_TOKEN          the Alerts bot, @TimbSwapTGBot (the same token
//                               match-notifier and reclaim-reminder send with)
//   TELEGRAM_WEBHOOK_SECRET     random string; also passed to setWebhook
//   TELEGRAM_BOT_USERNAME       optional, e.g. TimbSwapTGBot: ignore "/cmd@OtherBot"
//   BOT_RPC_URL                 optional Arbitrum Sepolia RPC; falls back to
//                               ALCHEMY_RPC_URL (the rpc function's), then the
//                               public endpoint
//   SUPABASE_URL                (auto-injected)
//   SB_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY   service key (bypasses RLS)
//
// Deploy: supabase functions deploy telegram-webhook --no-verify-jwt
// Register: see dev-docs/RECLAIM_REMINDERS.md (setWebhook with the secret), then
// setMyCommands with the list in RECLAIM_REMINDERS.md §3b (menu in the chat).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";
import {
  ADDR, CHAIN_ID, RateLimit, TtlCache, dmOnlyReply, faucetReply, helpReply, isGroup,
  linksReply, potReply, rankReply, roundReply, route, stakeReply,
  type FaucetState, type PoolState, type RankRow, type RoundState,
} from "./commands.ts";

const BOT_TOKEN   = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const HOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const BOT_NAME    = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "";
const RPC_URL     = Deno.env.get("BOT_RPC_URL") || Deno.env.get("ALCHEMY_RPC_URL") || "https://sepolia-rollup.arbitrum.io/rpc";
const SB_URL      = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE  = (Deno.env.get("SB_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;

const REMIND_HELP =
  "TimbSwap refund reminders 🕒\n\n" +
  "I'll DM you before an active ticket's refund window lapses, so you never " +
  "forfeit a stake by forgetting.\n\n" +
  "Subscribe:  /start <your wallet address>\n" +
  "Stop:       /stop\n\n" +
  "Everything else I can do: /help";

async function reply(chatId: number | string, text: string, replyTo?: number) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text, disable_web_page_preview: true,
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      }),
    });
  } catch (_e) { /* a failed reply must not 500 the webhook */ }
}

// ─── Chain reads ─────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const PRIZE_ABI = [
  "function getRoundState() view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement, uint256[6] digitCounters, bool[6] digitLocked)",
];
const VAULT_ABI = ["function previewAccrued() view returns (uint256)"];
const FAUCET_ABI = [
  "function ethPaused() view returns (bool)", "function timbsPaused() view returns (bool)",
  "function dripEth() view returns (uint256)", "function potEth() view returns (uint256)",
  "function timbsPerClaim() view returns (uint256)", "function cooldown() view returns (uint256)",
  "function ethReserve() view returns (uint256)",
];
const POOL_ABI = [
  "function rewardRatePerSecond() view returns (uint256)", "function totalStaked() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const prize   = new ethers.Contract(ADDR.TimbPrize, PRIZE_ABI, provider);
const vault   = new ethers.Contract(ADDR.TimbYieldVault, VAULT_ABI, provider);
const faucet  = new ethers.Contract(ADDR.GasFaucet, FAUCET_ABI, provider);
const staking = new ethers.Contract(ADDR.TimbStaking, POOL_ABI, provider);
const farm    = new ethers.Contract(ADDR.TimbFarm, POOL_ABI, provider);
const timbs   = new ethers.Contract(ADDR.TIMBSToken, ERC20_ABI, provider);

async function readRound(): Promise<RoundState> {
  const r = await prize.getRoundState();
  // Keep positions aligned: an unset slot (0x00) becomes " " so index i is segment i+1.
  const raw = String(r.currentWindow);
  let win = "";
  for (let i = 0; i < 6; i++) {
    const c = parseInt(raw.slice(2 + i * 2, 4 + i * 2), 16);
    win += c ? String.fromCharCode(c) : " ";
  }
  return {
    round: r.round, segment: r.segment, segmentStart: r.segmentStart, pot: r.pot,
    inSettlement: r.inSettlement, currentWindow: win,
    counters: [...r.digitCounters], locked: [...r.digitLocked],
  };
}

async function readPool(c: ethers.Contract): Promise<PoolState> {
  const [rate, total, finish] = await Promise.all([c.rewardRatePerSecond(), c.totalStaked(), c.periodFinish()]);
  return { rate, total, finish };
}

const now = () => Math.floor(Date.now() / 1000);

const answers: Record<string, () => Promise<string>> = {
  pot: async () => {
    const [s, y] = await Promise.all([readRound(), vault.previewAccrued().catch(() => null)]);
    return potReply(s, y, now());
  },
  round: async () => roundReply(await readRound(), now()),
  faucet: async () => {
    const [ethPaused, timbsPaused, dripEth, potEth, timbsPerClaim, cooldown, reserve, timbsBal] = await Promise.all([
      faucet.ethPaused(), faucet.timbsPaused(), faucet.dripEth(), faucet.potEth(),
      faucet.timbsPerClaim(), faucet.cooldown(), faucet.ethReserve(), timbs.balanceOf(ADDR.GasFaucet),
    ]);
    const f: FaucetState = { ethPaused, timbsPaused, dripEth, potEth, timbsPerClaim, cooldown, reserve, timbsBal };
    return faucetReply(f);
  },
  stake: async () => {
    const [s, f] = await Promise.all([readPool(staking), readPool(farm)]);
    return stakeReply(s, f, now());
  },
  links: async () => linksReply(),
};

// deno-lint-ignore no-explicit-any
async function rank(sb: any, wallet: string): Promise<string> {
  const { data: seasons } = await sb.from("seasons").select("id,name").eq("status", "active")
    .order("id", { ascending: false }).limit(1);
  if (!seasons || !seasons.length) return rankReply(wallet, null, null);
  const season = seasons[0] as { id: number; name: string };
  const { data: mine } = await sb.from("points_wallets")
    .select("display_tp,rounds_played,wins,sybil_flag")
    .eq("season_id", season.id).eq("address", wallet).limit(1);
  if (!mine || !mine.length) return rankReply(wallet, season.name, null);
  const m = mine[0] as any;
  const { data: r } = await sb.rpc("points_wallet_rank", { p_season: season.id, p_address: wallet });
  const row: RankRow = {
    rank: typeof r === "number" ? r : 0, display_tp: Number(m.display_tp) || 0,
    rounds_played: Number(m.rounds_played) || 0, wins: Number(m.wins) || 0, flagged: m.sybil_flag != null,
  };
  return rankReply(wallet, season.name, row);
}

const cache = new TtlCache<string>(30_000);
const limiter = new RateLimit(10_000);

// ─── Webhook ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Only Telegram, carrying the shared secret, may drive this.
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== HOOK_SECRET) {
    return new Response("forbidden", { status: 401 });
  }

  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); } // ignore junk

  // Edited messages are ignored: re-answering an edit would double-post.
  const msg = update?.message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || !text) return new Response("ok"); // non-message update — nothing to do

  const chatType: string | undefined = msg.chat.type;
  const group = isGroup(chatType);
  const r = route(text, chatType, BOT_NAME);
  if (r.kind === "silent") return new Response("ok");
  if (r.kind === "help") { await reply(chatId, helpReply(false)); return new Response("ok"); }
  if (r.kind === "dm-only") {
    if (limiter.allow(String(chatId), r.cmd, Date.now())) await reply(chatId, dmOnlyReply(r.cmd), msg.message_id);
    return new Response("ok");
  }

  const { cmd, arg } = r;
  if (!limiter.allow(String(chatId), cmd + (cmd === "rank" ? arg.toLowerCase() : ""), Date.now())) {
    return new Response("ok");
  }

  if (cmd === "help") { await reply(chatId, helpReply(group), group ? msg.message_id : undefined); return new Response("ok"); }

  // Private chat only from here for the wallet commands (route() enforces it).
  if (cmd === "start" || cmd === "stop" || cmd === "rank") {
    const sb = createClient(SB_URL, SB_SERVICE);

    if (cmd === "stop") {
      await sb.from("reclaim_subscribers")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("chat_id", String(chatId));
      await reply(chatId, "🔕 Reminders off. Send /start <wallet> to turn them back on.");
      return new Response("ok");
    }

    if (!arg) {
      await reply(chatId, cmd === "start" ? REMIND_HELP : "Send your wallet:  /rank 0xYourAddress");
      return new Response("ok");
    }
    let wallet: string;
    try {
      wallet = ethers.getAddress(arg.split(/\s+/)[0]).toLowerCase(); // validates checksum/shape
    } catch {
      await reply(chatId, `That doesn't look like a wallet address. Try:  /${cmd} 0xYourAddress`);
      return new Response("ok");
    }

    if (cmd === "rank") {
      try { await reply(chatId, await rank(sb, wallet)); }
      catch { await reply(chatId, "Points are unavailable right now. Try again shortly."); }
      return new Response("ok");
    }

    const { error } = await sb.from("reclaim_subscribers").upsert(
      { wallet, chat_id: String(chatId), active: true, updated_at: new Date().toISOString() },
      { onConflict: "wallet" },
    );
    if (error) {
      await reply(chatId, "Couldn't save that just now — please try again in a moment.");
      return new Response("ok");
    }
    await reply(
      chatId,
      `✅ Subscribed. I'll remind you before the refund window closes for\n${wallet}\n\nSend /stop anytime to turn this off.`,
    );
    return new Response("ok");
  }

  // Read-only chain commands, cached per command.
  let text2 = cache.get(cmd, Date.now());
  if (!text2) {
    try {
      text2 = await answers[cmd]();
      cache.set(cmd, text2, Date.now());
    } catch (e) {
      console.warn(`/${cmd} failed:`, (e as Error).message);
      text2 = "Data unavailable right now. Try again shortly.";
    }
  }
  await reply(chatId, text2, group ? msg.message_id : undefined);
  return new Response("ok");
});
