# Autonomous run log

What the swarm did overnight on 2026-09-04, and why. Newest entries at the bottom.

**Exit predicate:** every issue closed, no open PRs, `https://flights.mauri.app` serves the
real app, and a live search returns itineraries. A plateau is not a stop.

| # | Change | Predicate moved? | Evidence |
|---|---|---|---|
| 1 | Repo created, SvelteKit static PWA scaffolded, Pages enabled | yes | site returns 200 |
| 2 | 30 issues written from the brief, each quoting the lines it implements | yes | `gh issue list` |
| 3 | CI fixed: committed lockfile, pinned workspace root | yes | CI green after 4 red runs |
| 4 | Domain model merged (#1) | yes | unblocked every downstream issue |
| 5 | Cache merged (#4), stale-then-fresh over IndexedDB | yes | 40 tests |
| 6 | Key store merged (#3), BYOK with JSON import/export | yes | 72 tests passing together |
| 7 | Real home page replaces the SvelteKit scaffold | yes | production no longer says "Welcome to SvelteKit" |

## Decisions worth auditing

**Amadeus was abandoned before any code was written.** It was the intended source for both
flights and hotels. Its API hostnames no longer resolve in DNS, so the whole plan was
rebuilt around RapidAPI plus keyless sources. Checking this first, rather than after
building an adapter, saved the night.

**CORS was checked before the architecture was chosen.** The no-backend rule only works if
every provider allows browser origins. Six were measured before a line of provider code
existed. RapidAPI reflects the request origin and permits `x-rapidapi-key`, which is what
makes the design possible at all.

**The 20-requests-per-month quota reshaped the algorithm, not just a config value.** A
naive search costs far more than a month of free Skyscanner tier. So connection candidates
get ranked by free sources first, and metered calls are spent only on survivors. Issue #22
owns the budget, issue #12 owns the ranking.

**Expired cache was overruled after review.** The cache agent made expired entries unusable
as a fallback, on the grounds that a stale fare should not look current. Correct in
isolation, wrong here: when the monthly quota runs out, an old cached price is the only
data the app has, and honesty is served by labelling it rather than hiding it. Filed as #35.

**A tracking script was refused.** Travelpayouts' "Drive" affiliate script was declined
because this page holds the user's provider API keys in `localStorage`, and any
third-party script can read `localStorage`.

**The first UI was rejected by the owner as "boring and ugly", and he was right.** It was
the stock scaffold. `AGENTS.md` now requires UI agents to load the design skills before
writing CSS.
