# Fixture provenance

None of these were captured from a live call. Capturing one would mean either burning
part of Skyscanner's 20-requests-a-month free quota, or shipping a stranger's real
prices and hotel names into version control. Each file is hand-built to match the
provider's documented response shape closely enough to exercise real parsing code once
an adapter exists (issues #5 through #10).

| File | Provider | Endpoint shape modelled |
|---|---|---|
| `ryanair/one-way-fares.json` | Ryanair (keyless) | `farfnd/v4/oneWayFares` |
| `skyscanner/search-flights.json` | Skyscanner via RapidAPI `sky-scrapper` | `api/v2/flights/searchFlights` |
| `rome2rio/search.json` | Rome2Rio via RapidAPI | `search` (stops/segments/routes graph) |
| `booking/hotels-search.json` | Booking.com via RapidAPI `booking-com15` | `api/v1/hotels/searchHotels` |
| `transitous/plan.json` | Transitous/MOTIS (keyless) | `/api/v1/plan` (OTP-style itinerary) |
| `osrm/route.json` | OSRM (keyless) | `/route/v1/{profile}/{coordinates}` |

If the real shape turns out to differ once an adapter is written against it, fix the
fixture, not the mock helper in `tests/e2e/support/providers.ts` — the helper is just
plumbing, the fixture is the contract.
