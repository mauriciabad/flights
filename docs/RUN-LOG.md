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

| 16 | Search form live in production, every input from the brief | yes | screenshot, tiered rules working |
| 17 | Itinerary timeline merged, designed as a subgrid contract for the comparator | yes | 484 tests |
| 18 | Agoda and Booking stay adapters merged | yes | 12 real requests spent, fixtures captured |
| 19 | PWA installable: manifest linked, service worker registered | yes | manifest and sw.js both 200 in production |

| 20 | Search pipeline merged (#56), the keystone connecting providers to results | yes | 755 tests on integrated main |
| 21 | Settings live at /settings, BYOK with per-provider quota counters | yes | 200 in production |
| 22 | Map, geocoding, stay picker, timeline selection merged | yes | integrated build clean |

| 23 | Effect loop fixed (#87): search runs to completion | yes | providers answer, no console errors |
| 24 | Stay made optional and cost policy made quota-aware (#94) | yes | **first real itinerary returned** |

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

**Agoda's own dormitory flag is wrong.** `isDormitory` reads `false` on rooms literally named
"N-Bed Dormitory", so classification runs on the room name instead, with a guard against
"Private N Bed Dorm", which is a whole private room at four to five times the price. Trusting
the flag would have priced dorm beds as private rooms throughout, and trusting the name without
that guard would have done the reverse.

**The price calendar returns a year, not a month.** One request gives 366 contiguous days of
daily prices for a route. Six candidates across two legs is 12 requests for a full year of
prices, against a 50-request month; Sky Scrapper would need 4,392 requests for the same and has
20. This is the difference between an app that prices the dates you name and one that can tell
you when to go, which is #71.

**An unverified adapter was held out of main.** Kiwi's backend is switched off, so its types
were reconstructed rather than captured. The review found that its `healthCheck` does not fail
closed and its mapper has no runtime shape guard, so a shape drift would silently produce wrong
flight offers rather than an error. Held until both are fixed structurally, because wrong
flight data is worse than none.

That review generalised into #68: NO adapter validates response shape at runtime. These are
scraper APIs that change without notice, and two already have. A renamed field yields
`undefined`, which becomes `NaN` in a price. The sweep runs only when no adapter branch is open.

**Quota enforcement was wired to nothing, and the settings page proved it on screen.** The
budget module reserved, deduplicated, backed off and handled permanent 403s, and no adapter
called any of it. The cause was three modules independently inventing a provider identifier,
which `Record<string, number>` accepted silently: `getProviderCap('skyscanner')` missed the
table and returned a fallback of 10. The rendered settings page shows exactly that, with
Flights Sky reading a correct 40 because its id matches by coincidence and every other
provider reading 10 against its own stated 20, 50 and 500. Fixed by a provider-id union type,
so a drifted id is now a compile error rather than a quietly wrong number.

**The pipeline could hand a female-only dorm to a group with no female travellers.**
`fetchCheapestStay` picked by raw price with no fitness filter, so the search could produce a
total nobody in the party could book, before any UI had a chance to intervene. Found by the
stay-picker agent within an hour of the pipeline merging.

**A mixed-gender group was left honestly unresolved rather than averaged.** `Itinerary.stay`
is one stay for the whole party, so a female-only dorm covering one of four travellers cannot
be priced without inventing a formula. The picker excludes it and says why on screen instead
of guessing.

**The validation sweep paid for itself immediately.** It was filed as defensive hardening
against scraper APIs that change without notice. It found two bugs that were already live.

`null * 100` is `0` in JavaScript, so a null price from Agoda or Booking became a genuine
**zero-cost hotel** rather than an error. Not a crash, not a missing result: a wrong number
presented confidently as real, in the one place this app cannot afford to be wrong.

`info?.displayName?.trim()` threw a `TypeError` on a non-string, because optional chaining
guards `null` and `undefined` but not a wrong type. That one is a crash.

It also found Agoda's client carrying a header comment claiming a structural error check
existed when the code never had one, which is the specific reason `AGENTS.md` says a comment
is not a guard.

**Metropolitan codes came from our own data.** The 13 failing Ryanair requests per search
traced back to the Travelpayouts cheap-routes dataset, which returns `ROM`, `MIL` and `PAR` as
destinations from Barcelona. Those are IATA *city* codes covering several airports, so an
airport-level provider can never answer for them. The fix keys off the fact that OurAirports
has no entry for a metro code while it does have `DUS`, `ZRH` and `ALG`, so the data itself
separates "not an airport" from "an airport this airline does not serve", with no hardcoded
list to rot.

**Live verification caught what 849 tests could not.** Every unit test passed, every route
returned 200, every asset loaded, the PWA installed, and a real search returned nothing at
all, frozen by a Svelte reactive loop. The tests were not wrong; they tested the right things
at the wrong level. `stream-order.test.ts` proves result cards never reorder while streaming.
Nothing proved the stream was consumed.

## The exit predicate, met

**2026-09-04, verified live at https://flights.mauri.app with no API keys entered:**

Barcelona to Tallinn, a route with no direct flight, returns
**BCN → Dublin → TLL for €58.54**, both legs Ryanair, with free time from Wed 7 Oct 07:35 to
Mon 19 Oct 06:10. That is the thing the app exists to do, working, from a browser, against
live provider data, with no key and no backend.

It says three separate times that no bed was priced and that the total excludes a stay, and it
records its own provenance: "via Ryanair (no key required), fetched this minute". Getting that
right mattered more than finding the flight. An itinerary that quietly omits the hotel while
looking complete is worse than no itinerary.

**The two failures that stood between the code and this result were both invisible to the test
suite.** A single unawaited async call inside an `$effect` froze the page through 849 passing
tests and a green deploy. Underneath it, a rule I wrote into the pipeline brief, "stage 1
spends nothing", was correct for Skyscanner's 20-per-month quota and wrong for Agoda's 500, and
it made every itinerary unbuildable because stays could never resolve.

Neither was found by a test. Both were found by opening the site and trying to plan a trip.

## A verification that verified the wrong thing

The first "it works" claim in this log was wrong, and the way it was wrong is the useful part.

`BCN → TLL` returned a Dublin stopover for EUR 58.54, and that was recorded as proof the app
does its job. **Ryanair flies Barcelona to Tallinn directly**, one of 64 direct destinations
from BCN. So the test route did not need a stopover at all, and the app was solving a problem
that was not there. The result was real; it just did not demonstrate what it was taken to
demonstrate.

Testing a genuinely indirect route exposed the actual state. `BCN → OTP`, no direct flight,
returns **zero itineraries** while three workable stopovers exist in the same window, confirmed
by querying Ryanair's fare finder directly: Bergamo with 13 nights, Dublin with 1, Berlin with
4. BCN and OTP share 23 Ryanair connection airports. Filed as #115.

The status line gave the clue away: `Ryanair: answered (6 requests)` against a candidate cap of
6 is one leg per candidate, when an itinerary needs two.

This is the same failure as the reactive loop, one level up. There, 849 passing tests verified
code that never ran in a browser. Here, a browser test verified a route that never needed the
feature. **Choosing the test case is part of the test**, and a case that passes for the wrong
reason is worse than no case at all, because it stops the search.
