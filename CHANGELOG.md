# Changelog

Operator-facing log of what changed on the live deployment. Contract addresses
live in `config.js` (the source of truth) and are mirrored in `README.md` /
`SPECS.md`.

## 2026-09-16 — email wallet: MFA, passkeys, key export

**Continue with email — hardened.** The Privy embedded wallet (live since the
email-login drop) now carries the safety rails an extension would provide:

- **Authenticator-app MFA** (TOTP, QR enrol) and **passkey MFA** (Face ID /
  fingerprint / device PIN), both from *Wallet security* in the wallet menu.
  Once enrolled Privy asks for a check before the wallet signs, at most once
  every 15 minutes; either method can be removed from the same sheet.
- **Export private key** — warnings + disclaimer gate → fresh emailed code →
  MFA check → key masked on-page with *Copy key*. Client-side export (HPKE to
  the browser) is wired and switches on automatically once Privy enables it
  for the app; until then the sheet falls back to Privy's hosted copy button.
  Three "Invalid JWT" fixes along the way: the export page needs the *Privy*
  access token (reached through the SDK's internal object), and the
  authenticator must be verified first.
- *Wallet security* now appears on the first connect (was missing until a
  refresh).
- Confirmation sheet before every send / sign from the email wallet (decoded
  call, fee estimate, advanced gas / nonce) and a **360-minute idle timeout**
  for every wallet kind — shipped earlier in the same series.

**Decided against:** gas sponsorship through Privy (built as #432, closed
unmerged) — participants keep real tokens and allocate gas themselves; the
mainnet `GasFaucet` is the on-ramp. Recovery password, SMS MFA and smart
accounts are struck (see `dev-docs/EMAIL_LOGIN.md`, "Not in this drop").

**Site.** `Start Here` onboarding page (`/start/`) and a canonical nav on every
page; Quests & Points, Campaigns (Prize Month, Sep 25 – Oct 25) and Bug Bounty
pages; mainnet waitlist with Resend confirmation; Slither static-analysis gate
in CI.

## 2026-09-15 — faucet live, game repaired, airdrop deployed (held)

**Faucet (Arbitrum Sepolia) — live.** `GasFaucet 0x0a59b7d6…` bound to the
live gen-3 game. Turnstile-gated claim page → `faucet-claim` edge function
(reserves a 24 h slot, reads the chain for a live *Active* ticket) → GitHub
Actions keeper → `dispense()`. **TIMBS-only**: the deployed Sepolia
`TimbTreasury` predates the operator role the ETH legs need, so gas/pot drips
stay off on testnet (they work on the mainnet treasury). Proven end to end with
real claims.

**Live game — incident and repair.** The gen-3 migration script was run from
the dev-mirror checkout with the live shared addresses in `.env`, rebinding the
live `TimbYieldVault` (and briefly escrow/router) to a dev game. Symptom:
analytics counted 4 tickets while compete counted 1 entry. Repaired the same
day — vault rebound to `GameRegistry 0x11C24…`, tickets re-registered,
stranded weight cleared (`totalWeight` = the live tickets exactly). Prevention:
`DeployGen3Migration` now refuses to broadcast unless the on-chain bindings
match `EXPECT_OLD_PRIZE` / `EXPECT_OLD_REGISTRY`; the dev mirror's keepers are
dispatch-only. Full write-up: `dev-docs/INCIDENT_2026-09-15_SHARED_INFRA_REPOINT.md`.

**Airdrop (Arbitrum One) — deployed, on hold.** `TimbAirdropDistributor
0x955e5800245164EC4DCd1da9062115bBdA132c83`: 1 TIMB per eligible testnet
claim, 10,000 TIMB cap, one claim per address, owner = Safe, 1,000 TIMB float.
Dispatcher edge function `airdrop-dispatch` (secret-gated, cron every 5 min),
outbox with DB + on-chain dedup. Smoke-tested with two real payouts, then
**paused by the guardian until the public announcement** — `AIRDROP_ENABLED`
off, distributor `paused = true`, faucet page explainer hidden. Re-enable
order: unpause → secret → `config.js` flag.

**Repo hygiene.** The airdrop leg, the deployed `faucet-claim` source and the
Cloudflare Worker source were brought into this repo (the one that serves
timbswap.xyz). Risk docs wired: `dev-docs/CAPPED_BETA_GUARDRAILS.md` lever
table, `SECURITY.md` bounty scope (official repo), `MAINNET_ADDRESSES.md`.

**UI.** Faucet page nav/footer matched to the other pages; landing "Get Your
Tokens" → faucet (still wallet-gated); Debugger/DebugHub links removed
site-wide; DebugHub telemetry made localStorage-only (no network sink).

**Ops.** Settler healthy through the day (rounds #45 → #47). Telegram: bot
token rotated, ops DM + community group ids set and verified from a clean run;
`TELEGRAM_OPS_MODE` repo variable added (`all` / `errors` / `off`) to tune the
ops stream without touching secrets.

## Earlier

See `SPECS.md` → Deployment Log and `ROADMAP.md`.
