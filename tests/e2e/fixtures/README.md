# Fixture provenance

None of these were captured from a live call. Capturing one would mean either burning
part of Skyscanner's 20-requests-a-month free quota, or shipping a stranger's real
prices and hotel names into version control. Each file is hand-built to match the
provider's documented response shape closely enough to exercise real parsing code once
an adapter exists (issues #5 through #10).

| File | Provider | Endpoint shape modelled |
|---|---|---|
| `ryanair/active-airports.json` | Ryanair (keyless) | `api/views/locate/3/airports/en/active` — timezones AND each airport's `routes` |
| `skyscanner/search-flights.json` | Skyscanner via RapidAPI `sky-scrapper` | `api/v2/flights/searchFlights` |
| `rome2rio/search.json` | Rome2Rio via RapidAPI | `search` (stops/segments/routes graph) |
| `booking/hotels-search.json` | Booking.com via RapidAPI `booking-com15` | `api/v1/hotels/searchHotels` |
| `transitous/plan.json` | Transitous/MOTIS (keyless) | `/api/v1/plan` (OTP-style itinerary) |
| `osrm/route.json` | OSRM (keyless) | `/route/v1/{profile}/{coordinates}` |
| `markers.json` | — | the tokens below, read by the specs and by `tools/probe-results.mjs` |

## `ryanair/active-airports.json` is the whole world, not one provider's answer

Fourteen airports, and nothing outside them exists. Issue #379: the app also ships three
route datasets inside its own bundle: Ryanair's 224-airport snapshot, a 309-airport
all-carrier graph vendored from Wikipedia, and a cached-fare table.
`algorithm/connections.ts` proposes stopovers from those as readily as from a provider. They
arrive as ordinary app assets, so the network guard rightly lets them through, and every spec
here was ranking against them while its fixture named fourteen airports. #361 widened the
Wikipedia graph and three specs broke at once, none of which had changed.

`support/bundled-data.ts` answers those three chunks from this file now, projected through
the app's own `buildNetworkSnapshot`. So an airport in here exists everywhere, and
regenerating a dataset next week cannot move a spec.

One other bundled source is not a chunk and cannot be answered over the wire:
`FALLBACK_ROUTES` in `src/lib/algorithm/connections-fallback-data.ts`, eighteen airports
compiled into the app. It does not need answering, because a person edits it where the three
datasets above are regenerated on a schedule, so the universe is those two hand-written files
together. `../bundled-route-data.spec.ts` is the check that says so.

A spec whose world is different declares it as an array and passes it to `mockRyanairNetwork`,
which pins the provider response and the bundled graphs together from the one list.
`results-cls.spec.ts`, `stopovers-beyond-the-cap.spec.ts` and
`itinerary-map-transfers.spec.ts` all do.

Ryanair's two fare endpoints have no fixture file. `cheapestPerDay` and
`timtbl/3/schedules` have to agree with each other flight by flight — a fare the timetable
does not name never becomes an offer — so they are generated together from one list of
flights by `routeRyanairFlights` in `tests/e2e/support/providers.ts` rather than kept as
two files that can drift apart. The captured real responses live in
`src/lib/providers/flights/fixtures/` instead, where the unit tests exercise the join.

If the real shape turns out to differ once an adapter is written against it, fix the
fixture, not the mock helper in `tests/e2e/support/providers.ts` — the helper is just
plumbing, the fixture is the contract.

## Every file here goes through the code that reads it

`../fixture-mappers.spec.ts` maps each fixture through the mapper for its shape and fails
when one has no entry, so a new fixture opts in rather than slipping past. Adapters were
written after most of these were hand-built, and three of them had drifted apart without
anything noticing:

- `transitous/plan.json` had no `duration` on its only leg, which `isValidLeg` is right
  to refuse, so both suites spent months measuring the malformed-response branch (#194,
  #242). Fixed in #248.
- `booking/hotels-search.json` answered with `data.hotels[].property.name`;
  `booking-mapper.ts` reads `data.result[].hotel_name`.
- `skyscanner/search-flights.json` had no `segments` array, and `mapDirectItinerary`
  returns nothing without one.

The last two produced zero results every time and no spec used either mock, which is why
they sat there. Both are now rewritten from the captured responses in
`src/lib/providers/*/fixtures/`, which is where to look when a check here fails.

## A fixture must be worthless as an answer

An agent reported the app returning "BVC → LGW → PFO, EUR 238, via Ryanair, with zero
keys configured" and closed the loop on it. It was reading a mock. The fixture that
answered had been built to match the owner's reference itinerary exactly: his route, his
dates, two leg prices of 149 and 89 adding up to his EUR 238. Nothing about the answer
could tell it apart from the app working, and Ryanair does not serve BVC at all.

So the shape stays realistic, because that is what the parsers are tested against, and
the *values* are made worthless:

- **Prices** come from `FIXTURE_PRICES` in `../support/fixture-markers.ts` — €9,111.11,
  €9,222.22, €9,333.33, €9,444.44 a night. No fare or hostel bed costs that.
- **Flight numbers** come from `FIXTURE_FLIGHT_NUMBERS` — `ZZ0000` upward. `ZZ` is not
  an assigned IATA airline designator and no airline numbers a flight 0000, so these are
  impossible rather than merely unused.
- **Names** carry the word `FIXTURE`: airports, cities, countries, carriers, hotels,
  transit stops. Nothing in `src/` renders that word, and no real place is called it.
- **The acceptance route never appears.** `BVC` and `PFO` are banned from `tests/e2e/`
  by `../guard.spec.ts`, because a mock of the one route that decides whether this
  project works is the one mock nobody can sanity-check by eye.

`../guard.spec.ts` fails the suite if a fixture here carries no marker, and
`tools/probe-results.mjs` refuses to report an itinerary count when it finds one on a
page it just measured. Between them, a fixture that escapes its test announces itself.

IATA codes are the deliberate exception: they stay real. The app resolves a code against
its own OurAirports dataset (`src/lib/data/airports.ts`) for coordinates, city and
timezone, so a synthetic code returns no itinerary and the test stops exercising the
pipeline it exists to exercise. A leaked payload therefore still names real airports —
which is exactly why everything around them has to be obviously fake.

## What is deliberately not sanitised

`src/lib/providers/*/fixtures/*.json` are captured real responses, and they stay that
way. They are read by Vitest and handed straight to a pure mapper in Node; nothing
serves them over HTTP and no browser can ever be shown one. Their whole value is being
real — they are the only evidence in the repo of what these undocumented scraper APIs
actually send, and rewriting their values would delete the coverage they exist for. The
rule is about payloads that can reach a browser, not about every file called a fixture.
