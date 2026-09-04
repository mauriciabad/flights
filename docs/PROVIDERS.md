# Providers

Measured on 2026-09-04. Every claim here came from an actual request, not documentation.
Re-verify before trusting any of it, because two of the sources below died between the
docs being written and this project starting.

## The constraint that shapes everything

There is no backend. The owner ruled one out explicitly, so every call goes from the
browser straight to the provider with a key the user pasted into the UI. A provider that
does not send CORS headers is unusable here, no matter how good its data is.

That made CORS the first thing to check, before any code was written.

| Endpoint | Preflight | `Access-Control-Allow-Origin` |
|---|---|---|
| `sky-scrapper.p.rapidapi.com` | 200 | reflects the request origin |
| `booking-com15.p.rapidapi.com` | 200 | reflects the request origin |
| `rome2rio.p.rapidapi.com` | 200 | reflects the request origin |
| `api.transitous.org` | 200 | `*` |
| `services-api.ryanair.com` | 200 | `*` |
| `router.project-osrm.org` | 200 | `*` |

RapidAPI reflects the request `Origin` and lists `x-rapidapi-key` in
`Access-Control-Allow-Headers`, which is what makes the whole no-backend design work.

## What died

**Amadeus Self-Service** was the obvious first choice: one free signup covering flights,
hotels, airport routes and transfers. It is gone. `api.amadeus.com` and
`test.api.amadeus.com` no longer resolve in DNS, and `developers.amadeus.com/self-service`
redirects to the marketing homepage. Do not spend time on it again.

**Skyscanner's own API** is partner-only, approved case by case, aimed at established
travel businesses. The hackathon access you may have seen is granted through the event
organiser, not self-serve. Reaching Skyscanner data means going through RapidAPI.

**Hostelworld** has no RapidAPI listing at all (404 on the host). Hostel coverage has to
come from Agoda and Booking instead.

## RapidAPI, and the thing that will confuse you

A RapidAPI account does not grant access to anything. You subscribe to each API
individually, even for its free tier. An unsubscribed API returns:

```
HTTP 403  {"message":"You are not subscribed to this API."}
```

That looks like a bad key and is not. The settings UI must tell these two apart, because
the fixes are completely different.

Subscribing to a $0 plan does NOT require a payment method, despite a pricing FAQ entry
that suggests otherwise. The confirmation screen says "Total due today: Free" and
"No need to add any payment method".

### Free tier quotas, and why they dominate the design

All measured on the owner's account on 2026-09-04, after subscribing.

| API | Host | Free quota | Subscribed |
|---|---|---|---|
| Sky Scrapper (flights) | `sky-scrapper.p.rapidapi.com` | **20 / month**, hard limit | yes |
| Flights Sky (flights) | `flights-sky.p.rapidapi.com` | **50 / month**, hard limit | yes |
| Agoda (stays) | `agoda-com.p.rapidapi.com` | **500 / month**, hard limit | yes |
| Booking.com (stays) | `booking-com15.p.rapidapi.com` | **50 / month**, hard limit | yes |
| Rome2Rio (transport) | `rome2rio.p.rapidapi.com` | unknown | **no, see below** |

Agoda's 500 is the outlier and worth exploiting. Stay lookups can be relatively generous
while flight lookups must be hoarded, so do not apply one budget policy across all providers.

Provider slugs, since finding these cost real time:
`rapidapi.com/apiheya/api/sky-scrapper`, `rapidapi.com/ntd119/api/flights-sky`,
`rapidapi.com/ntd119/api/agoda-com`, `rapidapi.com/DataCrawler/api/booking-com15`.

### Sky Scrapper costs one request PER DATE, which changes the search design

Measured against the live API on 2026-09-04: `searchFlights` takes exactly one `date`
parameter and has no date-range form. There is one request per route per day.

Do the arithmetic against a 20-request month. A search over a ten-day departure window, on
two legs, is 20 requests. One search consumes the entire month.

So Skyscanner cannot explore a date range on the free tier. It can only confirm a specific
route on a specific day. Any pipeline that loops over dates calling it is broken by
construction, no matter how careful its caching is.

That makes the sequencing non-negotiable rather than merely preferable:

1. Free sources (Ryanair, and Travelpayouts' cached data via the build step) find which
   stopover cities and which dates are worth looking at.
2. The user picks a candidate.
3. Skyscanner is spent, deliberately and visibly, on that one route and date.

Two related findings from the same session. The v1 `searchFlightEverywhere` endpoint, which
would have backed `listDirectDestinations`, returns `{"status":false,"message":"Deprecated
version."}`, and its v2 replacement only returns country-level results, never per-airport
IATA codes. And responses carry **no time zone or offset at all**, only bare local datetime
strings, so an adapter has to supply the zone itself or silently mistime every overnight
flight.

Also worth knowing: `searchAirport?query=barcelona` returns both Barcelona and Barcelona,
Venezuela, so matching must compare `skyId` exactly rather than taking the first result.

### Rome2Rio cannot be subscribed to

The gateway route is alive. A nonexistent host returns 404 "API doesn't exists", while
`rome2rio.p.rapidapi.com` returns 403 "You are not subscribed to this API", so the listing
exists. It is simply not reachable through the marketplace.

Searching "rome2rio", "Rome2Rio" and bare "rome" returns zero results, site-wide and within
the 481-API Travel category, while "agoda" returns 25, so the search itself works. The old
official listing at `rapidapi.com/rome2rio/api/rome2rio-12` returns "API not found". Around
17 plausible provider slugs were tried directly and all were dead.

The likely explanation is that it was renamed or unlisted while the gateway stays up for
existing subscribers. Unless someone supplies a direct link to a current listing, this is a
dead end rather than a task.

Twenty requests a month is roughly one search. A single naive search costs far more than
that: two airport lookups, then two fare searches for every connection candidate, plus
hotels and transfers per candidate.

So request budget is a first-class product concern, not an optimisation. Rank connection
candidates before spending a single paid call on them, spend keyless providers freely,
and let the user decide when to spend the expensive ones.

## Keyless sources

These work with no key, no signup and no quota, which means the app does something useful
the first time it loads.

**Ryanair** publishes fares directly. Real prices, flight numbers, local times, plus a
route graph for direct destinations from any airport:

```
https://services-api.ryanair.com/farfnd/v4/oneWayFares?departureAirportIataCode=BCN&outboundDepartureDateFrom=2026-10-01&outboundDepartureDateTo=2026-10-20
```

It is one airline, so it is not a substitute for an aggregator. Its real value is as
ground truth: these fares come from the airline itself, so when an aggregator quotes a
different price for the same flight number, the aggregator is wrong.

**Transitous / MOTIS** answers the question ordinary flight search cannot: is there
actually a bus at the hour this flight lands, and if not, when is the next one.

```
https://api.transitous.org/api/v1/plan?fromPlace=LAT,LON&toPlace=LAT,LON&time=ISO8601
```

Their terms require a `User-Agent` naming the app with contact details, ask that the
project be open-source and non-commercial, and ask for attribution. Honour all three.
The service is free and run by volunteers.

**OSRM** gives walking and driving durations, keyless, on a shared demo server. Cache
hard and do not hammer it.

Issue #9 found that `router.project-osrm.org` — the host named in this doc's table
above and in the issue itself — ignores the `{profile}` segment of its own URL: a
`walking` request and a `driving` request for the same two points came back with
identical distance and duration, both at car speed (~51 km/h for the test pair used).
This matches a previously reported upstream issue (Project-OSRM/osrm-backend#4868), so
it is not specific to this session. `routing.openstreetmap.de`, the other
FOSSGIS-sponsored demo host on the same OSRM wiki page, routes each profile correctly
when selected by URL path prefix (`/routed-foot/...`, `/routed-car/...`) rather than by
the `{profile}` segment — the same test pair came back at a plausible ~4.5 km/h for
foot and ~51 km/h for car. Also verified with CORS `*`. The transfers/osrm.ts adapter
uses `routing.openstreetmap.de` for this reason; re-verify before assuming
`router.project-osrm.org` is safe to use for anything but driving.

**OurAirports** publishes a 12 MB public-domain CSV of every airport. Filter it at build
time. Never ship it to a phone.

## Travelpayouts, and why it cannot be called from the browser

**Verified 2026-09-04: Travelpayouts sends no CORS headers, so the browser cannot call it.**

This was checked two ways, because the earlier evidence was ambiguous. `curl` with
`Origin: https://flights.mauri.app` against `/v1/city-directions`,
`/aviasales/v3/prices_for_dates` and `/v1/prices/calendar` returns real 200 responses with
plausible cached fares and NO `Access-Control-Allow-Origin`. An OPTIONS preflight returns a
bare `404 page not found`, so there is no CORS handling at all. Then a live `fetch()` run
from `https://flights.mauri.app` itself threw `TypeError: Failed to fetch`, with Chrome
reporting the missing header explicitly.

So the data is real and the browser throws it away before any app code sees it.

### The build-time route out

The no-backend rule bans a server at *runtime*. It does not ban a build step, and this repo
already has one: the 12 MB OurAirports CSV is fetched and compiled to 165 KB of JSON during
the build.

Travelpayouts fits the same pattern. A scheduled GitHub Actions job can call it server-side,
where CORS does not apply, and commit a static JSON of cheap routes from a set of origins.
The app then reads a static file. No proxy, no server, no secret in the client, and the token
lives in Actions secrets rather than the user's browser.

That works because of what the free tier actually is. It returns recently cached prices, not
live search, so the data is already hours old and refreshing it nightly loses nothing. It is
a poor fit for a final quote and a good one for ranking which stopover cities are worth
spending a metered request on.

Response shape from `/v1/city-directions`:

```json
{ "data": { "<IATA>": { "origin", "destination", "airline", "departure_at",
  "return_at", "expires_at", "price", "flight_number", "transfers" } },
  "currency": "eur", "success": true }
```

`expires_at` is the cache-freshness marker and should survive into the domain model.

## Travelpayouts, original notes

Free, self-serve, and needs no credit card, because it is affiliate-funded: you earn per
booking rather than paying per call. Rate limits are generous, 300 requests per minute on
the price calendar endpoint.

The catch is that the free Data API serves recently cached prices rather than live search
results. Live search requires 50,000 monthly active users. For deciding which stopover
cities are worth pricing properly, cached data is the right tool and the quota is the
reason it can be used freely.

It aggregates many agencies through Aviasales, so unlike Ryanair it is a genuine
aggregator.

## The cheapest-price question

The owner's claim, in his words:

> in my experience skyscanner has always the cheapest price and agoda as well

The app should test that rather than assume it. Ryanair is ground truth for Ryanair
flights, so any aggregator quoting a different price for the same flight number is
measurably wrong. Issue #17 tracks turning this into a number instead of a belief.
