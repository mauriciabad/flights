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
