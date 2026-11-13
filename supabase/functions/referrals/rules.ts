// Pure rules for referrals (no Deno, no network), so they can be tested with
// plain Node: node supabase/functions/referrals/rules.test.ts

// Crockford base32: no I, L, O, U, so codes survive being read aloud or typed.
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_RE  = /^[0-9A-HJKMNP-TV-Z]{7,8}$/;
export const ADDR_RE  = /^0x[0-9a-fA-F]{40}$/;
export const QUALIFY_ROUNDS = 5;      // referee rounds before a referral counts
export const NETWORK_CAP    = 3;      // referred wallets per network per season
export const TIER_STEPS = [           // horizontal: the count is kept, the tier is read off it
  { tier: "S", at: 180 },             // 5 A
  { tier: "A", at: 36 },              // 4 B
  { tier: "B", at: 9 },               // 3 C
  { tier: "C", at: 3 },               // 3 D
  { tier: "D", at: 1 },               // 1 qualified wallet
] as const;
export const TIER_MAX = 180;
export const SIGN_WINDOW_MS = 10 * 60_000;

// Mirrors SQL referral_tier().
export function tierOf(n: number): string | null {
  for (const s of TIER_STEPS) if (n >= s.at) return s.tier;
  return null;
}

// Next tier and how many more qualified wallets it needs (null at S).
export function nextTier(n: number): { tier: string; need: number } | null {
  const up = [...TIER_STEPS].reverse().find((s) => s.at > n);
  return up ? { tier: up.tier, need: up.at - n } : null;
}

export function toBase32(bytes: Uint8Array, len: number): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5 && out.length < len) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= len) break;
  }
  return out;
}

// The wallet's code for a season: HMAC-SHA256(secret, "season|address"), first
// `len` base32 characters. Deterministic, but nobody can compute it without the
// secret. The first code stored for a wallet wins, so it never changes mid-season.
export async function codeFor(secret: string, seasonId: number | string, address: string, len = 7): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${seasonId}|${address.toLowerCase()}`)));
  return toBase32(mac, len);
}

// The exact message a referee signs to confirm their referral.
export function bindMessage(code: string, address: string, seasonSlug: string, issuedIso: string): string {
  return [
    "TimbSwap referral",
    `Code: ${code.toUpperCase()}`,
    `Wallet: ${address.toLowerCase()}`,
    `Season: ${seasonSlug}`,
    `Issued: ${issuedIso}`,
  ].join("\n");
}

// A signature's Issued time must be recent (and not from the future).
export function issuedOk(issuedIso: string, nowMs: number): boolean {
  const t = Date.parse(issuedIso);
  return Number.isFinite(t) && t <= nowMs + 60_000 && nowMs - t <= SIGN_WINDOW_MS;
}

// Plain-language result of referral_bind, for the page.
export const BIND_TEXT: Record<string, string> = {
  bound:         "Referral confirmed. It counts once you've played 5 rounds this season.",
  capped:        "Referral recorded, but this network already has 3 referred wallets this season, so it won't count.",
  already_bound: "This wallet already has a referral this season.",
  unknown_code:  "That referral code isn't active this season.",
  self:          "A wallet can't use its own referral code.",
  same_network:  "Referrals from the code owner's own network don't count.",
  not_new:       "Referrals are for new players: this wallet has already played.",
};
