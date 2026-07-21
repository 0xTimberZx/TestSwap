# TimbSwap Voice

How every user-facing string should sound — buttons, labels, empty states,
alerts, tooltips, docs blurbs. One voice, everywhere, at all times.

## The rule

> **Say what *you* get, in plain words — then let the machine be the fine print.**

Lead with the person and the outcome. The mechanism (contracts, yield, epochs,
settlement) is true and worth stating, but it belongs *after* the benefit, or in
smaller type, or on the docs page — never as the first thing a newcomer reads.

## Three words

- **Concise** — fewest words that carry it. Cut "in order to", "simply", "please",
  "you can now". If a line survives being read aloud in one breath, keep it.
- **Optimistic** — point forward. Even a dead-end state names the next move
  ("be the first", "you're in"), never just the absence ("none", "no data").
- **Conscious** — say the real state plainly and honestly. No hype, no
  fake-cute, no exclamation spam, no emoji-as-personality. Calm confidence reads
  as trustworthy; a mascot voice reads as a distraction.

## Do / Don't

- **Do** talk to the reader — "your tickets", "you split the pot", "what you put in".
- **Do** name the next action in empty and error states.
- **Do** keep the honest hook front and center: *what you put in stays yours*.
- **Don't** lead with jargon — "permissionless epoch settlement", "InsufficientOutputAmount".
- **Don't** perform warmth ("welcome home, kitten!", "🎉", "gm fren"). Warmth is
  in the clarity and the second person, not in stickers.
- **Don't** blame the user or the wallet in an error before you know the cause.

## Before → after

| Where | Cold (mechanism / dead) | Warm (concise · optimistic · conscious) |
|---|---|---|
| Hero CTA | Make a Swap | Get Your Tokens |
| Hero line | …permissionless smart contracts settle the round, record the winners, and pay a pot funded by the protocol's own yield… | Trade like you would anywhere. Every trade also enters the round — call six characters, and if the meter lands on them, you split the pot. **What you put in stays yours.** |
| Step | Nail the locked meter and split the pot with the other winners. | Match the locked meter and split the pot. |
| Entries empty | Connect wallet to view entries | Your tickets live here once you connect. |
| No tickets | No tickets yet | No tickets yet. Pick your six and you're in. |
| Pot loading | loading… | reading the pot… |
| No pool | No pool yet | No pool here yet — be the first. |
| Won a round | Claim 0.05 ETH | You called it. Claim your cut · 0.05 ETH |

## Fine-print exceptions

Some surfaces are *supposed* to be dense and literal — keep them precise, not warm:

- **Docs, litepaper, SPECS** — technical accuracy wins; this is the fine print's home.
- **The creds strip** (Open-source · Decentralized · Permissionless · Non-custodial ·
  EVM Native) — deliberately the words a DeFi native scans for. Keep it, but let it
  sit *below* the benefit, not compete with it.
- **Revert / safety messages** — must stay specific enough to act on ("raise
  slippage to 15%", "the pool moved between quote and mining"). Warm the framing,
  never blur the instruction.

## Checklist before you ship a string

1. Does it lead with the person / the outcome, not the machine?
2. Could a non-crypto friend read it once and get it?
3. If it's an empty or error state, does it point to the next move?
4. Any jargon, hype, or emoji doing the work that clear words should? Cut it.
5. Read it aloud — does it sound like a calm person, or a spec sheet?
