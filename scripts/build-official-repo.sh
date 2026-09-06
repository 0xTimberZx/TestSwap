#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-official-repo.sh — produce a CLEAN tree for the PUBLIC mainnet TimbSwap
# repo, from this (testnet) repo. NON-DESTRUCTIVE: it never modifies the source;
# it writes a fresh tree to $OUT that you turn into the official repo with a
# single fresh commit.
#
#   scripts/build-official-repo.sh [output_dir]     # default: ../timbswap-official
#
# Then:
#   cd <output_dir> && git init && git add -A && git commit -m "Initial commit"
#   git remote add origin git@github.com:<you>/timbswap.git && git push -u origin main
#
# What it does:
#   • copies ONLY the committed tree (no .git history, no gitignored cruft)
#   • strips internal/ops/testnet-only paths (dev-docs, hub copies, faucet, …)
#   • neutralizes testnet values in config.js to obvious placeholders (parseable)
#   • blanks env.example values (names only)
#   • replaces public keys/refs with REPLACE_WITH_* placeholders everywhere
#   • drops in a clean public README
# After running, complete config per dev-docs/MAINNET_BETA_CHECKLIST.md (§0, §3).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/../timbswap-official}"

echo "Source : $SRC"
echo "Output : $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"

# Committed tree only — respects .gitignore, no .git, no untracked files.
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$OUT"
cd "$OUT"

# ── 1. Strip internal / ops-strategy / testnet-only paths ────────────────────
rm -rf \
  dev-docs \
  debughub \
  scripts/docs scripts/Project6.md scripts/notes.md \
  scripts/faucet-worker.js scripts/epoch-state.json \
  faucet \
  supabase/functions/faucet-claim supabase/functions/faucet-status \
  .github/workflows/faucet.yml \
  .github/workflows/claude.yml \
  SPECS.md \
  .states t \
  scripts/build-official-repo.sh
echo "  stripped internal/testnet paths"

# ── 2. env.example → placeholders only (keep NAMES, blank VALUES) ─────────────
sed -i -E 's/^([A-Za-z0-9_]+)=.*/\1=/' env.example
echo "  env.example → names only"

# ── 3. config.js → address placeholders (kept parseable) ─────────────────────
# testnet contract addresses → zero-address placeholders (config.js ONLY, so we
# never zero addresses inside contracts/tests/abi).
sed -i -E 's/0x[0-9a-fA-F]{40}/0x0000000000000000000000000000000000000000/g' config.js
echo "  config.js addresses → zero placeholders"

# ── 4. Public keys / project ref → REPLACE_WITH_* everywhere ─────────────────
repl() { grep -rlZ "$1" . 2>/dev/null | xargs -0 -r sed -i "s#$1#$2#g"; }
repl 'PDKCOXR05xcN4AkdaVqNp'                          'REPLACE_WITH_MAINNET_ALCHEMY_KEY'
repl 'sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9' 'REPLACE_WITH_MAINNET_SUPABASE_PUBLISHABLE_KEY'
repl 'ipyfodnidwsdvwqrcjrl'                           'REPLACE_WITH_MAINNET_SUPABASE_REF'
echo "  rotated public keys/refs → placeholders"

# ── 5. Testnet chain id + hostnames → mainnet, repo-wide (mechanical & safe) ──
grep -rlZ '421614' .          2>/dev/null | xargs -0 -r sed -i -E 's/421614n/42161n/g; s/\b421614\b/42161/g'
grep -rlZ 'arb-sepolia' .     2>/dev/null | xargs -0 -r sed -i 's/arb-sepolia/arb-mainnet/g'
grep -rlZ 'arbitrum-sepolia' . 2>/dev/null | xargs -0 -r sed -i 's/arbitrum-sepolia/arbitrum-one/g'
grep -rlZ 'sepolia.arbiscan.io' . 2>/dev/null | xargs -0 -r sed -i 's#sepolia\.arbiscan\.io#arbiscan.io#g'
echo "  chain id + arbiscan/sepolia hostnames → mainnet"

# ── 6. Fresh public README ───────────────────────────────────────────────────
cat > README.md <<'MD'
# TimbSwap

A Uniswap-V2-style DEX and on-chain prize game on Arbitrum.

- **App:** https://timbswap.xyz
- **Network:** Arbitrum (mainnet)
- **License:** see [LICENSE](./LICENSE)

## What's here

| Path | |
|------|--|
| `contracts/` | Solidity sources (DEX, prize game, farms, vault, treasury, governance) |
| `abi/` | Published ABIs |
| `tests/` | Foundry tests |
| `scripts/` | Deploy scripts and keepers (settler, epoch, notifiers) |
| `workers/` | Cloudflare Worker — first-party `/api/*` (RPC + telemetry) |
| `supabase/` | Migrations + edge functions |
| the page dirs | Static frontend (vanilla JS) served on GitHub Pages |

## Configuration

Frontend contract addresses, chain, and RPC live in `config.js`. Values ship as
placeholders — set them for the target deployment. Server-side secrets are never
committed; see `env.example` for the variable names and provide them via your CI
secrets / Worker secrets.

## Build & test

```sh
forge build
forge test
```

## Deploy

Deploy scripts are under `scripts/` (Foundry). Provide the required env vars
(see `env.example`) via your secrets manager — never commit real keys.
MD
echo "  wrote clean README.md"

echo
echo "── manifest ─────────────────────────────────────────────"
echo "files: $(find . -type f | wc -l)"
echo "next : cd '$OUT' && git init && git add -A && git commit -m 'Initial commit'"
