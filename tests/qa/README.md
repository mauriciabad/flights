# `pnpm qa` — does the app behave properly when a person uses it

Four defects reached the owner in one day. Every one of them survived a thousand passing
unit tests and a green CI run, and every one would have been obvious within a minute of
using the app with real keys:

1. A search that priced a bed deleted the trip, so the app could only ever show bedless
   results. Both halves fixed now, by #152/#154 and #176.
2. One click could spend 48 Booking.com requests against a 50-a-month free tier.
3. The quota on screen was what one browser thought it had spent, not what the key spent.
   Fixed by #172.
4. Every reload after five minutes was a cold search, with three cache tiers sitting unused.

They are not the same bug, but they are the same kind of gap. Each is about how the whole
app behaves over a whole interaction, and the tests we had all ask about one part in
isolation. This suite asks the other question.

It does not replace anything. `pnpm test` still asks whether the parts work and `pnpm
test:e2e` still asks whether the screens work. Neither is weakened here, and no check below
duplicates one.

## Running it

```bash
pnpm qa          # the whole suite. ~35 seconds after the build.
pnpm qa currency # one file
QA_UNPIN=1 pnpm qa   # run the known-broken checks as ordinary checks, to read their evidence
pnpm qa:live     # keyless providers answer for real; metered ones never do
```

## What it costs

Nothing. Agoda, Booking.com, Skyscanner, Kiwi and Flights Sky are answered from a recording
in every mode — `tests/qa/support/bench.ts` blocks their hosts before a request can leave,
so there is no flag, no environment and no mistake that makes `pnpm qa` spend the owner's
month.

`pnpm qa:live` lets the keyless providers (Ryanair, OSRM, Transitous, Nominatim) answer for
real. That costs no money and is the only way to notice one of them changing its response
shape. It is not part of CI, because a suite that fails when a volunteer-run transit API is
having a bad afternoon stops being read.

It is also much slower: one live search took just over 45 seconds on a first run and 20 on a
warm one, against 3 seconds recorded, because it is a real Ryanair round trip per leg per
candidate with OSRM throttling itself on top. Timeouts widen automatically when `QA_LIVE=1`
is set. Run it when a provider's shape is in question, not on every change.

One invariant is deliberately absent for this reason. Whether RapidAPI sets
`Access-Control-Expose-Headers` on a real response — which decides whether a browser can
read the rate-limit counters at all — is unmeasured, and measuring it costs a metered
request against the owner's own key. `quota-from-headers.qa.ts` proves the app derives its
number from the response when the header is readable; it cannot prove the real header is
readable, and it says so rather than pretending otherwise.

## The invariants

| File | Holds |
|---|---|
| `bench-answers.qa.ts` | The recording still answers the endpoints this app calls, and a scenario search still produces itineraries. Sorts first because every other check rests on it. |
| `cost-per-search.qa.ts` | One search stays inside a declared per-provider request budget, every provider it touches has one, and the budget itself still leaves a month of searches. |
| `currency.qa.ts` | Pricing a bed never removes an itinerary, a rendered itinerary quotes one currency, and a configured stay provider actually prices a bed. |
| `cache-served.qa.ts` | A reload paints the previous answer from cache before the network can reply, inside the TTL and past it, and never calls a stale number current. |
| `quota-from-headers.qa.ts` | The remaining quota on screen is the provider's own number, not a local tally. |
| `no-fabricated-flights.qa.ts` | Every itinerary names the provider that sourced it, flies legs that provider had a sellable fare on, and shows no flight number that is not in a timetable it served. |
| `no-fixture-data.qa.ts` | No recorded response reaches a live answer, and the detector that decides that still works. |

## How it is built

**`budget.ts`** is the one place a per-search request cost is written down. Raising a number
there is a deliberate act, and the failure message says what it costs in searches per month.
Free-tier sizes are imported from `src/lib/settings/provider-catalog.ts` rather than copied.

**`support/bench.ts`** answers every provider from a recording and remembers what it
answered. Most of what this suite asserts is about the traffic rather than the pixels, and
the request log is usually the half the screen leaves out. It installs automatically for
every check — a check that forgot to ask for it would otherwise run with no interception at
all, which happened once while this was being written and quietly turned a red check green.

**`support/responses.ts`** answers like the provider, not like a test. Ryanair prices a day
on a leg it flies and answers a month of `unavailable` rows for one it does not, which is
what its own fare calendar does for a route it has no service on. Agoda quotes in the
currency it was asked for and in USD when nobody asked, which is what `agoda-mapper.ts`
recorded the real Agoda doing on 2026-09-04. A bench that always says yes cannot catch a
caller that forgot to ask, and that one branch is the whole reason the currency defect is
visible here.

Ryanair's fares take two endpoints since #137 — `cheapestPerDay` for the price,
`timtbl/3/schedules` for the flight number — and `ryanair-mapper.ts` drops any fare the
timetable does not confirm, so both are derived from one `benchFlight` function. If they
disagreed by a minute the suite would return no itineraries and say nothing about why.

**`support/markers.ts`** is the single seam for "this value was never sold by anybody". It
re-exports #156's `tests/e2e/fixtures/markers.json`, so a token added there is a token this
suite recognises and nothing in this directory changes.

**`known-broken.ts`** pins the checks that fail today to the open issue that owns each fix.
Every entry it started with is gone: #154, #155 and #156 landed while this was in review,
and #146, #158 and #165 landed in #172, #176 and #174 during the rebase that made the suite
measure anything at all. What is pinned now is two defects this suite found — #188, a crash
the flight-number check walked straight into, and #194, a reload that stopped painting from
cache the day #174 merged.

Playwright fails the run when an expected-to-fail check passes, so a defect cannot be fixed
and quietly un-covered — the suite goes red until somebody deletes the entry. A new
regression in the same area still fails the ordinary way. A pin is also a promise that the
issue is open: check the tracker before you add one, and delete one whose issue has closed.

## Adding a check

Ask whether it is about behaviour over a whole interaction. "Does `formatMoney` round
correctly" is a unit test. "Does the price on the card match the price in the comparator
after a widen" is one of these.

Then:

1. Put it in a new `*.qa.ts`, importing `test`/`expect` from `./support/bench`.
2. Assert on the traffic (`bench.requests`, `bench.bodies`) as well as the screen, wherever
   the traffic is what makes the answer unambiguous.
3. Write the failure message for somebody who has never seen the check: name the invariant,
   quote the observed value, and say where the fix lives. Every message in here is written
   that way, and it is the only reason the pinned ones are readable.
4. If it fails today because the app is broken, pin it in `known-broken.ts` with its issue
   number rather than softening it.

If a new provider appears, give it a host in `support/catalog.ts` and a budget in
`budget.ts`. Until you do, the bench blocks it and says so — a provider whose cost nobody
declared is a cost nobody has looked at.
