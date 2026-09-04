# Handoff, 2026-09-04 afternoon

Written because the session was about to hit its limit. Read `docs/ACCEPTANCE.md` first, it
defines what "working" means here. Then this, then `gh pr list` and `gh issue list`.

## Where the app actually is

The owner's reference route **works**, verified on production with no keys configured:

```
https://flights.mauri.app/results/?dep=2026-10-06&arr=2026-10-12&from=BVC&to=PFO
2 of 2 itineraries
BVC -> LGW -> PFO   EUR 229   TUI Airways + easyJet
BVC -> BHX -> PFO   EUR 250   TUI Airways + Jet2
```

He planned the same trip by hand at EUR 238 via Gatwick. The app now finds it for nine euros
less. `BCN -> OTP` returns 4 itineraries, 26 requests cold and 0 on reload.

What fixed it was **Kiwi's keyless public GraphQL endpoint** (#157), not a key. Every other
adapter answered "I don't know" when asked what flies out of Boa Vista, so the candidate graph
was empty and the search ended before any fare provider was asked.

## What is still wrong, in priority order

1. **No bed is ever priced (#158).** #154 threaded `currency` into the stay query, but nothing
   sets `SearchDependencies.currency`, so Agoda is still called without `currency_id`, still
   answers USD, and the stay is still dropped against EUR flights. The plumbing was fixed and
   the tap was never turned on. Acceptance condition 3 fails on this alone.
2. **The default pick is a 24-night stopover (#167).** `nightBonusPerNight: 40` is unbounded
   and an unpriced bed reads as EUR 0, so longer is always better. Live in production now.
3. **Kiwi undoes the cache work (#165).** 46 requests a search, and expired entries discarded
   rather than served stale, which reverses #155 for any page with a Kiwi result.
4. **The quota counter is fiction (#146).** It lives in `localStorage` while the quota belongs
   to the RapidAPI key, and nothing reads the rate-limit headers that arrive on every response.

## Both metered flight providers are exhausted this month

Flights Sky returned `429 ... exceeded the MONTHLY quota`, and Booking.com is at roughly 85
percent. Both were spent by this project, not by the owner. **Do not spend metered requests**;
see the AGENTS.md section on his quota. Kiwi, Ryanair, OSRM and Transitous are keyless.

Related: #159, a monthly-quota 429 is retried three times as if it were a rate limit.

## Traps that have each cost hours

- **The shared MCP browser serves fixture data.** Route interception from an e2e spec outlived
  it and answered real Ryanair hostnames with mocks priced to match the reference itinerary
  exactly, so an agent reported the app working when it was reading its own fixture. Launch
  your own Chromium. Fixtures are now priced at EUR 9,111.11 with `ZZ0000` flight numbers, and
  `tools/probe-results.mjs` refuses to report a count when it detects one.
- **`api.skypicker.com` 403s a HeadlessChrome User-Agent** and 200s an ordinary one. Use the
  committed probes in `tools/`, which share `probe-browser.mjs`. A probe without it reports
  Kiwi as FAILED on routes that work fine, which produced two false readings in one afternoon.
- **`E2E_PORT` is what isolates an e2e run**, not `CI=1`. Runs have silently attached to another
  worktree's server and failed against a branch nobody here wrote.
- **Check `git branch --show-current` before committing.** Worktrees have been switched and
  reaped under running agents.

## How to check anything

```sh
node tools/probe-results.mjs '<results url>'   # count beside the network log
node tools/probe-reload.mjs  '<results url>'   # cold vs warm request cost
node tools/probe-search.mjs Paris              # what the airport field offers
```

Verify against production, in your own browser context, as a person would. Green CI has not
caught one of the defects that reached the owner.

## Open PRs left mid-flight, and where each one stands

Several agents were told to push whatever they had rather than lose it when the session ran
short, so some of these are drafts and some are red. Read the PR body before assuming
anything; each says what is done and what is left.

**#150, the design and header work, is a draft with one real unsolved failure.** All three of
its fixes are finished: the 60-minute walk and 240-minute drive caps, the header clipping
(`min-height` to `height` on `.app-shell`, so the grid's `1fr` can resolve), and the visual
pass with airline logos, mode icons and place marks. `pnpm check`, `pnpm test` and `pnpm build`
all pass on it.

What blocks it: `select-and-compare.spec.ts`'s "picker change updates the total" fails 3 out of
3 locally and in CI with "Clicking the checkbox did not change its state". That file is
untouched by the branch, and main's own CI is green, so it is an interaction rather than a
broken main. It started after main advanced past the branch's earlier rebase point, and the
prime suspect is the `flightKey`-based equality check that arrived with #136/#140's
`FlightPicker.svelte` refactor meeting this branch's new `SegmentIcon` and `AirlineLogo`
rendering inside the picker rows.

The next step, which the agent ran out of time to do: bisect `TransportPicker.svelte`,
`ItineraryTimeline.svelte` and `ResultCard.svelte` against main, then check whether rendering
those two new components inside a picker row defeats the `flightKey` equality.

Do not merge a red PR to clear the queue. The whole reason the owner's route works today is
that several agents stopped and reported instead of pushing through something they had not
understood.

**#173, the transit timing work, is finished but needs a rebase before it can merge.** It
fixes every Transitous query being planned for the second you pressed search rather than for
the journey, and it delivers the brief's "what happens if you miss the last one" at zero extra
requests, because MOTIS already returns the later departures in the same response. Seven
commits landed on main while it was being written; its author left a PR comment naming the
overlapping files, and expects real conflicts in `pipeline.ts` and `resources.ts`. Not done: an
e2e spec for the new copy, and `svelte-autofixer` over the two touched components.

It also fixed a bug nobody had filed: the mapper took `itineraries[0]`, but MOTIS returns that
array unordered. A real response came back 02:16, 02:17, 02:40, 02:43, 02:31, 02:46, 03:08.
That is where the "13:28 before 13:27" ordering in #135 came from.
