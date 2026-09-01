# Abandoned-ticket revenue — the community-tilted lapse split

## The mechanism (unchanged foundation)

A ticket's principal is refundable through a generous window — `LER+4` rounds for
non-winners, `LER+6` for a ticket that won its last eligible round (the 2-round
claim window runs first, *then* the 4-round refund window). Past that, the stake
has been abandoned: the owner had every round to reclaim it and didn't.

Forfeiture is **time-gated and permissionless** — the settler sweeps it in
`onRoundSettled`; no admin decides who forfeits or when. (The M3 change removed
the only discretionary path: an admin can no longer mark a live ticket Ineligible
and seize it — see `dev-docs/GOVERNANCE_HARDENING.md`.)

## Where the money goes (the optic)

Rather than 100% to the house, lapsed **ETH principal** is split:

- **`lapsePotBps`** (default **70%**) is recycled into the **live prize pot** via
  `TimbPrize.addToPot()` — it goes back to players as a bigger pot.
- the remainder (**30%**) goes to the **protocol sink** (Treasury).

Lapsed **TIMBS principal** routes wholly to the sink: the pot is ETH-only, and the
Treasury already buys back and burns TIMBS, so that value flows to token holders.

The split is:

- **transparent** — `LapseSwept(ticketId, toPot, toSink, token)` is emitted on
  every sweep; dashboard the lifetime totals next to the audit.
- **deterministic** — a fixed basis-points ratio, no discretion.
- **timelock-tunable** — `setLapsePotBps` is owner-gated (the timelock), bounded
  by `BPS`. Set 0 for the legacy all-to-sink behavior, 10000 for all-to-pot.
- **non-blocking** — both legs are best-effort; the escrow is decremented only by
  what actually left, so a failing leg can never freeze the settlement loop nor
  double-spend on a retry (whatever couldn't be disposed stays on the ticket).

## Why this reads well

The house still earns a clear, modest cut of genuinely abandoned stakes, but the
majority visibly returns to the people still playing — "unclaimed stakes fund
bigger pots, and nobody decides it, the clock does." Compare the alternative
("the house keeps 100% of your forgotten deposit"), which is the line a critic
pulls right after you've made "no admin can touch your stake" a selling point.

## Planned follow-up — reclaim reminders (Telegram)

To make forfeiture *rare* (the best optic is that almost nobody forfeits): a
lightweight nudge in the existing settler/worker will ping active-ticket holders
when their refund is claimable and near expiry ("refund claimable, expires in N
rounds"), reusing the Telegram plumbing already in `scripts/settler.js`. Not in
this change; tracked as the next step.

## Tests
`tests/LapseSplit.t.sol` — default 70/30, tunable to all-pot / all-sink,
`setLapsePotBps` bound, and full ticket disposal (status Ineligible, escrow 0).
