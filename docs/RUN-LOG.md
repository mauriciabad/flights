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

| 8 | Provider interface merged (#2), the chokepoint six adapters build on | yes | 84 tests |
| 9 | Airport dataset merged (#11): 12 MB CSV to 165 KB gzipped, lazy-loaded | yes | bundle measured |
| 10 | Connection graph merged (#12), ranks stopovers before spending a request | yes | 15 tests |
| 11 | Design system merged (#15), replacing the scaffold look | yes | assets fetched individually, tokens confirmed live |
| 12 | Custom domain closed (#21) after fetching a hashed asset, not just the page | yes | CSS 200, HTTP 301 to HTTPS |

| 13 | Ryanair, Transitous, OSRM, cross-check, expired-cache and E2E harness merged | yes | 209 tests on integrated main |
| 14 | Travelpayouts cheap-route data now fetched nightly in CI | yes | 29 real BCN routes, 6.9 KB committed |
| 15 | Provider budget, key-model reconciliation and Skyscanner adapter queued | partly | PRs open |

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

**Travelpayouts was chosen by the owner, then failed a gate.** It sends no CORS headers, so
the browser cannot call it and there is no backend. Proven with real 200 responses carrying
fare data and no `Access-Control-Allow-Origin`, then a live `fetch()` from the deployed site
throwing in Chrome. The agent stopped rather than reaching for a public CORS proxy, which
would have routed the owner's token through a stranger's server. Split into #51 (Kiwi.com,
which does pass CORS and invented virtual interlining) and #52 (Travelpayouts fetched in CI
at build time, which the no-backend rule permits since it bans a runtime server, not a build
step).

**Rome2Rio turned out to be unbuyable.** Its gateway answers 403 not-subscribed rather than
404, so a listing exists, but it returns zero results in RapidAPI search site-wide while
other terms work. Issue #7 now tracks an optional Google Maps transit adapter instead, with
Transitous as the primary. Arguably the better outcome: Rome2Rio returns typical durations
and would claim a bus runs at 02:00 when the last one left at 23:40.

**A silent wrongness was caught before it shipped.** `router.project-osrm.org`, named in the
issue and in our own docs, ignores its own profile segment and returns car speeds for walking
requests. Every "walk to the hotel" estimate would have been roughly ten times too fast, and
nothing would have looked broken. Switched to `routing.openstreetmap.de`.

**History was deliberately not rewritten.** Twelve screenshots totalling 1.8MB were committed
by two of my own `git add -A` calls. The whole `.git` is 6.3MB and six PR branches were open,
so a force-push would have invalidated every one of them for a saving nobody would notice.
Fixed by ignore rules instead, which addresses the recurrence rather than the artefact.

**The single most useful discovery came from checking a fallback.** After Kiwi's backend
turned out to be switched off upstream, probing the already-subscribed Flights Sky revealed a
price calendar: one request returns a price for EVERY DAY across about a month. Sky Scrapper
charges one request per date, so a ten-day window over two legs costs its entire 20-request
month; the same question costs 2 requests here against a 50-request month.

The free tiers were never comparable by headline numbers, and the search is three tiers rather
than two: free sources, then the calendar to find which cities and dates are cheap, then a
per-date confirmation only on the itinerary the user picks. The pipeline brief was rewritten
mid-flight because of it.

**A geocoder was already in the stack, unnoticed.** The search form shipped unable to turn
free text into coordinates, documented honestly as a limitation. Transitous, which we already
use for timetables, geocodes keylessly with CORS and returns a timezone alongside the
coordinates. That second field matters more than the first: Skyscanner sends no timezone at
all, so its adapter hand-curates an IATA-to-IANA table and drops any airport missing from it.
A hand-maintained timezone table rots silently, and when it is wrong an overnight itinerary
gains or loses a night, which is a wrong hotel booking and a wrong total.
