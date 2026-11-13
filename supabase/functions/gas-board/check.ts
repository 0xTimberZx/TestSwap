// Pure rules for the gas request board (no Deno or network), so they can be
// tested with plain Node: node supabase/functions/gas-board/check.test.ts

export const CHAIN_ID       = 421614n;               // Arbitrum Sepolia
export const AMOUNT_WEI     = 3_000_000_000_000_000n; // 0.003 ETH per request
export const HAS_GAS_WEI    = 2_000_000_000_000_000n; // a wallet holding this already has gas
export const EXPIRE_HOURS   = 48;
export const MAX_PER_IP_DAY = 3;

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

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
  if (BigInt(tx.value) < AMOUNT_WEI) return "That transaction sent less than 0.003 ETH.";
  const createdSec = Math.floor(new Date(req.created_at).getTime() / 1000);
  if (blockTimestampSec === null || blockTimestampSec < createdSec - 60) return "That transaction is older than the request.";
  return null;
}

