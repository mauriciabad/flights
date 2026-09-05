# Exit predicate for the "finish the project" run

Started 2026-09-04. Owner's instruction: run in a loop until the project finishes.
This file exists so the predicate survives a context compaction. Do not relax it to
declare victory. A plateau is not a stop.

Check it with `.audit/check-predicate.sh` (fast) or `.audit/check-predicate.sh --full`.

## The predicate

- **P1** `gh issue list --state open` is empty.
- **P2** `gh pr list --state open` is empty.
- **P3** The acceptance trip from `docs/ACCEPTANCE.md` passes against production, in a
  fresh browser context: BVC to PFO, 6 to 12 October 2026, one traveller.
  - probe exits 0, so no fixture data leaked into the measurement
  - at least one itinerary, on the first search, with no second button to press
  - the page does not say "No bed priced for this stopover"
  - no console errors
- **P4** On `origin/main`: `pnpm check`, `pnpm build`, `pnpm test` and `pnpm qa` are green.
  (`pnpm qa` arrives with PR #168. Until it merges, that leg is reported as PENDING, not
  as a pass.)
- **P5** A returning visitor gets the current build without a hard reload, measured by
  `node tools/probe-sw-update.mjs`.

## What the predicate deliberately does not say

Closed issues are not the measure. The owner said so in his own words: "cont confuse
closing issues with actually having a working software". P1 and P2 are bookkeeping. P3 is
the one that decides it, and P3 can fail with a clean tracker.

## Caveat on P3b, found 2026-09-04 while reading the first baseline

The probe runs a fresh browser with no keys. Both stay adapters, Agoda and Booking, need a
RapidAPI key, so in that browser "Bed not priced" is the honest answer and not a bug. P3b
therefore cannot pass until either a keyless bed source exists or the check is run with a
key loaded. The first baseline reported P3b as passing because it grepped for the exact
string "No bed priced", which the #183 redesign had already reworded. That was a vacuous
pass, and the kind this run must not accept.
