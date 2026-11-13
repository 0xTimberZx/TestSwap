// Pure rules for the gas request board (no Deno or network), so they can be
// tested with plain Node: node supabase/functions/gas-board/check.test.ts

export const CHAIN_ID        = 421614n;               // Arbitrum Sepolia
export const AMOUNT_WEI      = 3_000_000_000_000_000n; // 0.003 ETH: what a request asks for (and the team sends)
export const RESOLVE_MIN_WEI = 1_000_000_000_000_000n; // 0.001 ETH: a third of the ask counts as resolved
export const HAS_GAS_WEI     = 2_000_000_000_000_000n; // a wallet holding this already has gas
export const PUBLIC_HOURS    = 6;    // on the public board this long, then the team queue
export const EXPIRE_HOURS    = 24;   // unresolved after this → expired
export const COOLDOWN_HOURS  = 24;   // one post per address per 24 h, from its last post or resolution
export const MAX_FILLS_PER_ADDRESS = 3;  // lifetime: an address can be helped at most 3 times
export const MAX_OPEN        = 30;   // the public board refuses new posts beyond this
export const SHOW_MAX        = 5;    // the board shows the oldest 5; the rest wait their turn
export const MAX_PER_IP_DAY  = 3;    // posts per network (salted IP hash) per 24 h

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const H = 3600_000;

// Why a fill is refused, or null when it is good.
export function checkFill(
  req: { address: string; created_at: string; status: string },
  tx: { to: string | null; from: string; value: string; blockNumber: string | null },
  receiptStatus: string | null,
  blockTimestampSec: number | null,
  chainIdHex: string,
): string | null {
  if (req.status !== "open") return "This request is no longer open.";
  if (BigInt(chainIdHex) !== CHAIN_ID) return "The board only accepts Arbitrum Sepolia transactions.";
  if (!tx.blockNumber || receiptStatus === null) return "That transaction isn't confirmed yet. Try again in a minute.";
  if (receiptStatus !== "0x1") return "That transaction failed on chain.";
  if (!tx.to || tx.to.toLowerCase() !== req.address) return "That transaction wasn't sent to this address.";
  if (BigInt(tx.value) < RESOLVE_MIN_WEI) return "That transaction sent less than 0.001 ETH.";
  const createdSec = Math.floor(new Date(req.created_at).getTime() / 1000);
  if (blockTimestampSec === null || blockTimestampSec < createdSec - 60) return "That transaction is older than the request.";
  return null;
}

// Why a new post from this address is refused, or null when it may post.
// `history` is every earlier request row for the address; `openCount` is how
// many requests are on the public board now.
export function checkRequest(
  history: { status: string; created_at: string; filled_at: string | null }[],
  nowMs: number,
  openCount: number,
): string | null {
  const fills = history.filter((r) => r.status === "filled").length;
  if (fills >= MAX_FILLS_PER_ADDRESS) return `This address has already been helped ${MAX_FILLS_PER_ADDRESS} times.`;
  const since = nowMs - COOLDOWN_HOURS * H;
  const recent = history.some((r) =>
    new Date(r.created_at).getTime() > since || (r.filled_at !== null && new Date(r.filled_at).getTime() > since));
  if (recent) return "One request per address every 24 hours, counted from the last post or resolution.";
  if (openCount >= MAX_OPEN) return "The board is full right now. Try again in a few hours.";
  return null;
}

// Requests still open and young enough for the public board.
export function isPublic(createdAtIso: string, nowMs: number): boolean {
  return new Date(createdAtIso).getTime() > nowMs - PUBLIC_HOURS * H;
}
