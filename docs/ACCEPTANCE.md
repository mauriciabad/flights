# What "working" means

Written 2026-09-04, after the owner said: "cont confuse closing issues with actually
having a working software".

Twenty PRs merged and a nearly clean tracker still left an app that answers his own trip
with "No itineraries found". So closed issues are not the measure. This file is the measure.

## The one test that decides it

**Boa Vista (BVC) to Pafos (PFO), 6 to 12 October 2026, one traveller.**

The owner planned this trip by hand before asking for the app. His answer, recorded in
`docs/prompts/007-morning-review.md`: EUR 238 of flights via London Gatwick, EUR 44 for a
hostel, **EUR 282 total**.

The app works when it returns that trip, or a better one, and every part of it is real.
All of the following at once:

1. At least one itinerary on the first search, with no second button to press.
2. Every flight in it exists, on the airline named, on the date shown.
3. A bed is priced into the total. Not "No bed priced for this stopover".
4. The nights in the stopover are a number the traveller chose, not the only date pair an
   adapter happened to return.
5. Ground transport for the day of travel, not for the moment the search ran.
6. A total within sight of EUR 282, and a reason on screen when it is not.

Nothing else counts as done while this fails.

## Never ship a flight that does not exist

An empty result disappoints. A fabricated itinerary is a booking the traveller cannot make,
discovered at an airport they have already flown to.

This is not hypothetical. An agent reported verifying "BVC to LGW to PFO, EUR 238, via
Ryanair". Ryanair does not serve BVC, RAI or SID, all `404` on the route endpoint, meaning
not in its network at all, and LGW's Ryanair route list holds four entries with PFO not
among them. That itinerary described two flights that do not exist.

So before merging any change that claims a search returns results, check one flight it
produces against the provider that supposedly sells it. An offer whose airline the sourcing
provider does not fly is the highest-severity bug in the repo, ahead of every feature.

## How to check, so that the check means something

Against production, in your own browser context, the way a person would.

- `node tools/probe-results.mjs '<url>'` prints the itinerary count beside the network log.
- `node tools/probe-search.mjs Paris` prints what the airport field really offers.

Both launch their own Chromium, for the reason AGENTS.md gives: the shared browser has
moved tabs underneath an agent mid-measurement and produced two false bug reports.

A green CI run means the tests we thought to write still pass. It has not caught one of the
defects that reached the owner.

## Reporting

Say what you observed. Mark inference as inference. "The widget genuinely lists BVC to LGW"
was an inference stated as an observation, and it was false.
