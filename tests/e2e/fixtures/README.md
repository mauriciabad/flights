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

Ryanair's two fare endpoints have no fixture file. `cheapestPerDay` and
`timtbl/3/schedules` have to agree with each other flight by flight — a fare the timetable
does not name never becomes an offer — so they are generated together from one list of
flights by `routeRyanairFlights` in `tests/e2e/support/providers.ts` rather than kept as
two files that can drift apart. The captured real responses live in
`src/lib/providers/flights/fixtures/` instead, where the unit tests exercise the join.

If the real shape turns out to differ once an adapter is written against it, fix the
fixture, not the mock helper in `tests/e2e/support/providers.ts` — the helper is just
plumbing, the fixture is the contract.

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
