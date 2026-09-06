# Exit predicate for the stay-card and map run

Started 2026-09-06, 10:45. Owner's instruction: "work fully autonomous, don't ask me
questions, I go away". This file exists so the predicate survives a context compaction.
Do not relax it to declare victory. A plateau is not a stop.

The predicate for the previous run is in `EXIT-PREDICATE.md` and still stands. This one
is additional and covers the five issues opened from the owner's review of the hotel card
and the maps.

## The predicate

- **E1** Issues 404, 405, 406, 407 and 408 are closed, each because its own acceptance
  was re-checked against production after the deploy, not because a PR merged.
- **E2** `gh pr list --state open` is empty.
- **E3** Against production, in a fresh browser context with no keys, on the acceptance
  trip from `docs/ACCEPTANCE.md`:
  - **E3a** a stay row carries a per-mode journey time with an icon, and shows no walking
    time where walking is not plausible
  - **E3b** the stay list offers a sort control, defaulting to recommended, and switching
    key reorders the list, the map points and the map sidebar together
  - **E3c** a transit leg shows a fare estimate where the table covers its city, and says
    so plainly where it does not
  - **E3d** a ground-leg preview beside water shows water rather than a solid grey box,
    country boundaries are visible, and neither can be read as a leg of the trip
- **E4** On `origin/main`: `pnpm check`, `pnpm build`, `pnpm test` and `pnpm qa` green.
- **E5** The measurement itself is trustworthy: the probe exits 0, no fixture marker from
  `tests/e2e/fixtures/markers.json` appears anywhere, and there are no console errors.

## Decisions this run owns, because the owner is away

He said not to ask. So these are mine, stated here so he can reverse any of them.

- **The coastline may get heavier.** He asked for water, land and country boundaries at
  ground-leg zoom, having already been told once that this data was declined on weight.
  Asking again is not a fix. The rule I am applying instead: nothing heavy lands in the
  initial bundle, a static asset fetched on demand is not a backend, and preview render
  time at five cards does not regress from its ~100 ms.
- **A fix ships even where coverage is partial.** A transit fare table that covers thirty
  cities beats no estimate at all, provided the uncovered case says so rather than
  guessing.
- **An issue can be wrong.** Shipping the measurement that kills a proposed feature is a
  real outcome and closes the issue.
