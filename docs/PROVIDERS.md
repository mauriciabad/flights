# Providers

Measured on 2026-09-04. Every claim here came from an actual request, not documentation.
Re-verify before trusting any of it, because two of the sources below died between the
docs being written and this project starting.

If you are reading this to answer "which aggregator should I use", the answer is
[Kiwi.com's public API](#kiwicoms-public-api-keyless-cors-open-and-a-real-aggregator).
Every other candidate was measured and rejected, and each one's reason is in "What died" so
nobody has to find out twice.

## The constraint that shapes everything

There is no backend. The owner ruled one out explicitly, so every call goes from the
browser straight to the provider with a key the user pasted into the UI. A provider that
does not send CORS headers is unusable here, no matter how good its data is.

That made CORS the first thing to check, before any code was written.

| Endpoint | Preflight | `Access-Control-Allow-Origin` |
|---|---|---|
| `sky-scrapper.p.rapidapi.com` | 200 | reflects the request origin |
| `agoda-com.p.rapidapi.com` | 200 | reflects the request origin |
| `booking-com15.p.rapidapi.com` | 200 | reflects the request origin |
| `rome2rio.p.rapidapi.com` | 200 | reflects the request origin |
| `api.transitous.org` | 200 | `*` |
| `services-api.ryanair.com` | 200 | `*` |
| `router.project-osrm.org` | 200 | `*` |
| `api.skypicker.com` | 204 | `*` — see "Kiwi.com's public API" below |

RapidAPI reflects the request `Origin` and lists `x-rapidapi-key` in
`Access-Control-Allow-Headers`, which is what makes the whole no-backend design work.

### Measure CORS from a browser, and not with a headless User-Agent

`curl` cannot answer the only question that matters here. It never sends a preflight and
never enforces the response, so it reports success for endpoints a browser refuses.
`tools/probe-cors.mjs` exists for this: it serves a page from a real `http://` origin,
navigates its own Chromium there, runs `fetch()` from that document, and prints both what
the page saw and what the wire actually carried.

There is a second trap underneath the first, and it cost real time on 2026-09-04.
**Playwright's default headless User-Agent says `HeadlessChrome`, and at least one host
treats that as a bot.** Measured against `api.skypicker.com` on the same day, same machine,
minutes apart:

```
UA: ...HeadlessChrome/141.0.0.0...   ->  HTTP 403, no CORS headers at all
UA: ...Chrome/141.0.0.0...           ->  HTTP 200, access-control-allow-origin: *
```

A headless probe therefore reports "this endpoint has no CORS" for an endpoint every real
visitor can call perfectly well, and the wrong conclusion looks exactly like a correct one.
`tools/probe-cors.mjs` and `tools/probe-results.mjs` both set an ordinary Chrome UA by
default for this reason. Real users are never affected — a page cannot override its own
User-Agent, and a browser sends a normal one.

## Kiwi.com's public API: keyless, CORS-open, and a real aggregator

**Measured 2026-09-04 from a real browser page origin, not from curl.**

`https://api.skypicker.com/umbrella/v2/graphql?featureName=<name>` is the GraphQL backend
kiwi.com's own website runs on. No key, no signup, no account, no quota, and:

```
POST .../umbrella/v2/graphql?featureName=SearchOneWayItinerariesQuery
Origin: http://127.0.0.1:8788
-> HTTP 200
-> access-control-allow-origin: *
-> access-control-allow-credentials: true
```

The OPTIONS preflight (a JSON content-type triggers one) answers `204` with the same
`access-control-allow-origin: *` and a long `access-control-allow-headers` list. A plain
`{query, variables}` POST body is enough; none of the `KW-*` headers its own site sends are
required. Schema introspection also answers, which is how the two query documents in
`providers/flights/kiwi-public-queries.ts` were written — Kiwi publishes no documentation
for this endpoint.

This is the only genuine aggregator this project has found that a browser can call with no
key at all. It is also, by a distance, the most useful thing in this document, because of
what it can answer that nothing else here can.

### The capability that actually mattered: `listDirectDestinations`

`algorithm/connections.ts` builds its candidate stopover list from `listDirectDestinations`.
Before this endpoint, every adapter's answer to that question was some flavour of "I don't
know":

| Adapter | Answers "which airports does X fly to directly"? |
|---|---|
| Sky Scrapper | No. v1 `searchFlightEverywhere` is deprecated; v2 returns country-level results only |
| Flights Sky | No. It has no such endpoint |
| Kiwi (RapidAPI listing) | No. Its backend has been 402 since before it was written |
| Ryanair | Only for the 224 airports in its own network snapshot. Boa Vista, Sal and Praia are in none of them |
| Travelpayouts cheap routes | Only for the origins in the build-time list, and thinly |

So for an origin outside Ryanair's network the connection graph had nothing to rank, and
the search reported "No itineraries found" **no matter which keys were configured**. That is
the real reason the owner's own trip returned nothing. It was never a missing key.

`onewayOnePerCityItineraries`, with `destination: { ids: ["anywhere"] }` and
`maxStopsCount: 0`, answers it for any airport in one request. Measured live:

```
BVC ->  LIS OPO LUX ORY LGW BHX MAN MUC DUS STR ZRH FRA   (12 airports, with EUR prices)
LGW ->  63 airports, PFO among them
```

Note what that is and is not. It is a *fare* search filtered to direct flights, so it lists
destinations that have real, bookable, priced seats in the window asked about — not a route
map. A route that only flies in another season will not appear. That is the honest answer
for a search happening now, and it is strictly better than a stale route map that proposes
edges a fare search then has to spend a request disproving.

### What it returns for the reference route

`docs/ACCEPTANCE.md`'s test is Boa Vista to Pafos, 6 October 2026. Captured live and kept as
`providers/flights/fixtures/kiwi-public-oneway-*.json`:

```
BVC -> LGW   TUI Airways BY259   2026-10-06 12:40 -> 20:30   EUR 173
LGW -> PFO   Jet2 LS3159         2026-10-08 15:15 -> 21:50   EUR  63
```

Every station carries its own IANA zone (`Atlantic/Cape_Verde`, `Europe/London`,
`Asia/Nicosia`), which is why this adapter needs no Transitous timezone lookup at all —
contrast `skyscanner-timezone.ts`, which exists purely because Sky Scrapper sends bare local
strings.

Run end to end against a real build with zero keys configured, the app went from
**"0 of 0 itineraries shown — No itineraries found"** to **two itineraries, the cheapest
EUR 229 via London Gatwick**. The owner's own hand-planned answer for the same trip was
EUR 238 of flights via London Gatwick.

### Limits, stated plainly

- **It is undocumented and belongs to someone else's website.** It can change shape or start
  refusing traffic with no notice. Every field is re-validated in
  `kiwi-public-mapper.ts` and a failure degrades to "this source doesn't know".
- **One flight per offer, deliberately.** Kiwi's speciality is stitching several carriers
  into one self-transfer itinerary, and it does that for this very route (BVC→LIS easyJet,
  LIS→STN Ryanair, STN→PFO Jet2, USD 267). But a domain `FlightOffer` is one flight with one
  flight number, and this app builds the connection itself so it can put a night in the
  middle. Flattening a three-leg journey into one offer would describe a flight nobody sells.
  What "one flight" means got more precise in issue #210 — see the next section.
- **A headless User-Agent gets a 403 with no CORS headers.** See the section above. This
  affects probes, never real users.
- **Whether its price scales with `passengers.adults` was not measured**, so the adapter
  sends `adults: 1` always and declares `'per-person'` — true by construction rather than by
  assumption (issue #109).
- **Route lookups are capped at 40 per session**, because `connections.ts` asks
  `listDirectDestinations` once per candidate and only caps the candidate list afterwards. A
  real cold BCN→OTP search spent **120 requests** against this endpoint before the cap, which
  is the same shape issue #121 measured for Ryanair (80) and #145 fixed with a bundled
  network snapshot. Kiwi has no whole-network endpoint to fix it that way. With the cap the
  same search spends 52 and still returns 4 itineraries; BVC→PFO, the origin this adapter
  exists for, spends 19 and never reaches the cap at all.

### A technical stop is a stop, as far as Kiwi's filter is concerned

Issue #210, measured 2026-09-04 from a browser origin. This one is worth reading before
touching the filter again, because the interesting part is not in the mapper.

`maxStopsCount: 0` does not mean "nonstop". Kiwi counts a touchdown you sit through as a
stop, so the filter excluded a real single-flight product, and no amount of fixing the
mapper would have found it — the itinerary was never in the response:

```
BVC -> FCO   maxStopsCount: 0    0 itineraries
BVC -> FCO   maxStopsCount: 1    Neos NO4864, BVC 13:40 -> SID 14:10, SID 15:10 -> FCO 23:50
                                 one aircraft, one flight number, one booking, EUR 262
```

**`Segment.followingTechnicalStop` is Kiwi's own answer**, found by introspecting the live
schema (`__type(name: "Segment")`) rather than guessed at. It is undocumented and carries no
description, so the direction was read off a real response: on that Neos itinerary the FIRST
segment (BVC→SID) is `true` and the second is `false`, so it describes the stop that
*follows* a segment. `kiwi-public-mapper.ts` requires it to agree with the
same-carrier-same-flight-number rule and falls back to that rule alone if the field ever
disappears. Never treats absence as `true`.

Three things that look like they would work and do not:

- **`enableSelfTransfer: false` is not a plane-change filter.** It drops Kiwi's own stitched
  multi-carrier itineraries, and that is all. With it set, BVC→LGW still offered TAP 1568
  then TAP 1334 via Lisbon on ONE booking, two flight numbers, twelve hours apart. It is
  worth sending as a narrowing device; it is not worth trusting as a discriminator.
- **A `layover` object is present on a technical stop too**, with `duration: 3600`,
  `isStationChange: false`, `isBaggageRecheck: false`. Its presence proves nothing.
- **`onewayOnePerCityItineraries` cannot return segments.** `OnePerCityItinerary` is an
  interface exposing only `price`, `source`, `destination`, `discountPercentage`,
  `outboundDepartureDateRange` and `departureDate`, so the route-graph query cannot filter
  technical stops client-side the way the fare query does. It has to lean on the filter, and
  its destination list is therefore "reachable on one booking with at most one short stop" —
  a superset of "one flight". A candidate that turns out not to be costs one fare request to
  disprove.

That widening is what makes the route findable at all: `connections.ts` can only propose a
stopover some source has listed, and Rome was missing from Boa Vista's list precisely
because the only flight there stops in Sal. Measured for BVC over the adapter's own 14-to-44
day window: 11 destinations before, 20 after, against the 60+ an unfiltered one-stop search
returns. A hub barely moves — BCN goes from 77 to 81.

Nothing about a nonstop changes. BVC→LGW and LGW→PFO, the two legs `docs/ACCEPTANCE.md`'s
reference route is built from, return identical itinerary sets before and after (4 and 22).

## What died

Everything in this section was re-measured on 2026-09-04 rather than inherited. Each row is
a real request or a real DNS lookup.

**Amadeus Self-Service** is gone, and the earlier claim in this file is confirmed rather
than merely repeated. `test.api.amadeus.com` and `api.amadeus.com` return `NOERROR` with
zero answer records from both `8.8.8.8` and `1.1.1.1` — the DNS signature of a subdomain
that no longer exists — while `developers.amadeus.com` and `www.amadeus.com` resolve fine,
so this is not a wider `amadeus.com` outage. `developers.amadeus.com/self-service` 301s to
the marketing homepage. Amadeus notified users it was decommissioning the Self-Service
portal, with existing keys disabled on 17 July 2026
([PhocusWire](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers)).
There is nothing left to test CORS against. Do not spend time on it again.

**Duffel** sends no CORS headers. Measured from a browser: the preflight to
`api.duffel.com/air/offer_requests` fails with "No 'Access-Control-Allow-Origin' header is
present", and a plain GET to `/air/airports` fails the same way. Their own help centre says
this is deliberate and recommends a backend proxy, which this project cannot have. Test mode
is free but its fares are simulated, not real.

**Travelpayouts, all of it, including Hotellook.** Confirmed again from a browser:
`api.travelpayouts.com` (`/v1/city-directions`, `/aviasales/v3/prices_for_dates`,
`/v1/prices/calendar`), `engine.hotellook.com`, `yasen.hotellook.com`, `min-prices.aviasales.ru`,
`hydra.aviasales.com`, `www.jetradar.com` and `tp.media/content` all throw
`TypeError: Failed to fetch` with "No 'Access-Control-Allow-Origin' header is present".
Two Travelpayouts hosts DO send `*` — `autocomplete.travelpayouts.com/places2` and
`www.travelpayouts.com/widgets_suggest_params` — but the first returned `[]` for "Paphos"
and the second `{}`, so neither carries usable data. **Hotellook is dead outright**, not
merely CORS-blocked: every `engine.hotellook.com/api/v2/cache.json` variant returns `404`.
Travelpayouts discontinued the Hotellook brand and closed its API and widgets in October
2025. The build-time route (`scripts/fetch-cheap-routes.mjs`) remains the only way to use
Travelpayouts at all.

**Kiwi's Tequila programme** (`api.tequila.kiwi.com`) is alive but runs an origin
allowlist, not RapidAPI-style reflection: `Origin: https://tequila.kiwi.com` gets a `200`
with a matching `access-control-allow-origin`, while any other origin gets `400
Disallowed CORS origin` and no header at all. A GitHub Pages origin would have to be added
to Kiwi's list by hand. Reported to be invitation-only for new partners as well. Note this
is a completely different service from the keyless umbrella endpoint above, despite the
shared brand — do not confuse the two.

**SerpApi** (`serpapi.com/search.json?engine=google_flights`) sends no CORS headers.

**Wizz Air** (`be.wizzair.com`) sits behind Kasada: a GET reflects the origin but the
OPTIONS preflight returns `401` with no CORS headers, so a browser POST never goes out.
**easyJet**'s old `ejavailability` endpoint returns Akamai "Access Denied". **Aer Lingus**'s
`fixedFlight` route no longer exists. **Kayak** redirects any API-shaped path to
`/help/bots.html`. **Skyscanner's** own `conductor` endpoint sends `*` but answers `403`
with a PerimeterX captcha. **Norwegian** and **SunExpress** show Cloudflare challenges.

**OpenSky** and **Flightradar24** are keyless but pin `access-control-allow-origin` to their
own site (`https://opensky-network.org`, `https://www.flightradar24.com`), which blocks every
third-party origin. They also carry positions, not fares.

**Skyscanner's own API** is partner-only, approved case by case, aimed at established
travel businesses. The hackathon access you may have seen is granted through the event
organiser, not self-serve. Reaching Skyscanner data means going through RapidAPI.

**Hostelworld** has no RapidAPI listing at all (404 on the host). It does have its own web
backend, which is keyless and CORS-open and is now this app's baseline for beds — see
"Hostelworld's own backend" below. Going looking for a reseller was the wrong instinct
twice: for flights it ended at Kiwi's own endpoint, and for beds at Hostelworld's own.

### Keyless and CORS-open, but not flight prices

Worth knowing about, none of them a substitute for an aggregator:

| Host | CORS | What it is |
|---|---|---|
| `en.wikipedia.org/w/api.php` (with `&origin=*`) | `*` | Airport articles carry a current "Airlines and destinations" table. A worldwide route graph, but it needs wikitext parsing plus an article-title-to-IATA index. `&origin=*` is required; without it no CORS header is sent |
| `www.wikidata.org/w/api.php`, `query.wikidata.org/sparql` | `*` | Maps Wikipedia article titles to IATA codes (`P238`) in one batched call |
| `raw.githubusercontent.com/.../openflights/.../routes.dat` | `*` | 67,663 routes. Free and fetchable, but frozen around 2014 |
| `airlabs.co/api/v9/routes` | `*` | Real schedule/route data, free key, 1,000 requests/month. No fares |
| `api.aviationstack.com` | `*` | Free key, 100 requests/month. Status and schedules, no fares |
| `api.flightapi.io`, `app.goflightlabs.com` | `*` | Real fare search with CORS, but no usable free tier |

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
| Kiwi.com Cheap Flights (flights) | `kiwi-com-cheap-flights.p.rapidapi.com` | **300 / month**, hard limit, 1000/hour rate | yes |
| Agoda (stays) | `agoda-com.p.rapidapi.com` | **500 / month**, hard limit | yes |
| Booking.com (stays) | `booking-com15.p.rapidapi.com` | **50 / month**, hard limit | yes |
| Rome2Rio (transport) | `rome2rio.p.rapidapi.com` | unknown | **no, see below** |

Agoda's 500 is the outlier and worth exploiting. Stay lookups can be relatively generous
while flight lookups must be hoarded, so do not apply one budget policy across all providers.

#### Bigger free tiers exist on RapidAPI, if a metered provider is ever needed again

Swept on 2026-09-04. 32 further flight and hotel listings were confirmed to exist at the
gateway (an unsubscribed host returns `403 "You are not subscribed to this API."`; a
nonexistent one returns `404 "API doesn't exists"`), and the 15 most promising had their
pricing pages read in a real browser — RapidAPI's marketplace is client-rendered, so `curl`
and plain fetching return an empty shell and tell you nothing.

| Host | Free quota | What it is |
|---|---|---|
| `priceline-com-provider.p.rapidapi.com` | 500/mo | Real flight search, plus hotels and cars. The best all-round find |
| `booking-com18.p.rapidapi.com` | 530/mo | Hotels — more than 10x the `booking-com15` listing this app uses |
| `flight-fare-search.p.rapidapi.com` | ~300/mo (10/day) | Flight search v2, plus airport search |
| `kiwi-com-flights-api.p.rapidapi.com` | 300/mo | The most complete Kiwi clone found: one-way, round-trip, multi-city, price calendar/graph/map, nomad |
| `google-flights2.p.rapidapi.com` | 150/mo | Google Flights scraper |
| `skyscanner-flights4.p.rapidapi.com` | 100/mo | Another Skyscanner scraper |

Two caveats before acting on any of that. RapidAPI's own documentation says a card is
required for freemium listings, to charge overages — which covers every listing above,
since they all have paid tiers alongside the $0 one. And `kiwi10.p.rapidapi.com`, which
advertises 500,000 requests/month and looks like the jackpot in a search result, has two
generic endpoints named "test" and "getData" and is filed under Education. It is a
placeholder, not a flight API.

None of these were subscribed to or called, because Kiwi's own keyless endpoint made them
unnecessary. They are recorded so the next person needing a metered flight source starts
from a measured list rather than repeating the sweep.

Provider slugs, since finding these cost real time:
`rapidapi.com/apiheya/api/sky-scrapper`, `rapidapi.com/ntd119/api/flights-sky`,
`rapidapi.com/ntd119/api/agoda-com`, `rapidapi.com/DataCrawler/api/booking-com15`,
`rapidapi.com/emir12/api/kiwi-com-cheap-flights`. The header search box finds Kiwi's
listing (`/search?term=kiwi`); the bare `/search/<term>` path drops the query string and
returns an unfiltered list, which cost real time to notice.

### The quota headers, and what is actually known about them (issue #146)

**Nothing in this repo has ever captured a RapidAPI response's headers.** Every fixture
under an adapter's `fixtures` directory and under `tests/e2e/fixtures` is a response body.
The quotas in the table above were read off RapidAPI's dashboard, not off a response. So
this section separates what is documented from what has been measured, because the app now
depends on the difference.

**Documented by RapidAPI, unverified here.** Its gateway is documented to return the
subscribed plan's quota on every response:

```
x-ratelimit-requests-limit      the plan's total allowance
x-ratelimit-requests-remaining  what is left of it
x-ratelimit-requests-reset      seconds until it resets
```

and, separately, a short burst window under the bare names `x-ratelimit-limit` and
`x-ratelimit-remaining` (documented as 60 seconds). Those two are easy to confuse and the
consequences are not symmetric. Reading "5 of 1000 left this minute" as the month's
allowance would record 995 requests spent and refuse every search for the rest of the
month.

**Not known, and it is the question that matters.** A browser can only read a response
header the server names in `Access-Control-Expose-Headers`. Whether RapidAPI exposes
`x-ratelimit-*` cross-origin has not been measured. If it does not, these headers exist on
the wire and the browser throws them away before app code sees them, exactly as happened
with Travelpayouts (see "Travelpayouts, and why it cannot be called from the browser").

So `src/lib/providers/budget/rate-limit-headers.ts` is written for their absence. It
matches header names by shape rather than from a fixed list, records the names it actually
saw, refuses to classify a window it cannot show to be a plan quota, and treats "no
headers" as "we learned nothing" — never as "zero remaining". If they never arrive, the app
behaves exactly as it did before, on a per-browser estimate.

**How to answer this for free, whenever someone next has a reason to call one of these
APIs.** It costs no extra request, because the answer rides on a call already being made:

```js
page.on('response', (r) => {
  const h = r.headers();
  if (r.url().includes('.p.rapidapi.com')) {
    console.log(r.url(), Object.keys(h).filter((k) => k.includes('ratelimit')), h);
  }
});
```

Write what comes back here, verbatim, including the case where the list is empty — an
empty list is the finding, not a failed measurement. Do not spend a request to run this on
its own.

### Flights Sky has a price calendar, and it is the reason this app is affordable

**Measured 2026-09-04.** `flights-sky.p.rapidapi.com/flights/price-calendar` returns a price
for EVERY DAY across roughly a month, in ONE request:

```
GET /flights/price-calendar?fromEntityId=BCN&toEntityId=VIE&departDate=2026-10-15&currency=EUR
```

```json
{"data":{"flights":{"days":[
  {"day":"2026-09-04","group":"high","price":124.0},
  {"day":"2026-09-15","group":"low","price":34.0},
  {"day":"2026-09-19","group":"low","price":33.0}, ...]}}}
```

Update, issue #61: "roughly a month" undersold it. A full capture of that same BCN-VIE call
came back with **366 contiguous days, no gaps** — from *today*, not from the requested
`departDate`, running exactly one year forward. `fromEntityId`/`toEntityId` also turned out to
want the letters-only `skyId` ("BCN"), not the numeric `entityId` `auto-complete` also
returns; passing the numeric id answers 400 `"SkyId can contain only letters"`. That is one
measurement against one route, not a guarantee every route behaves identically — re-verify
before assuming "always 366 days" elsewhere.

Compare that with Sky Scrapper, which costs one request per date. Exploring a ten-day window
over two legs is 20 Sky Scrapper requests, its entire monthly quota, versus **2** here.

So the free tiers are not comparable by their headline numbers. 50 requests that each answer
"what does every day of the next month cost on this route" is worth far more than 20 that
each answer "what does this one day cost".

That makes the search shape obvious. Use the price calendar to find WHICH dates and which
stopover cities are cheap, across many candidates, for a handful of requests. Only then spend
a per-date request confirming one specific itinerary.

The `group` field (`low`/`medium`/`high`) is the API's own cheapness banding and is free
signal for ranking, so use it rather than recomputing a threshold.

Endpoints confirmed live and returning 200 with a real key:
`/flights/auto-complete`, `/flights/search-one-way`, `/flights/search-roundtrip`,
`/flights/price-calendar`. Note `departDate` is required even for the calendar, which
otherwise returns `{"errors":{"departDate":"departDate is required"}}`.

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

### Agoda and Booking (stays, issue #10), and the honest state of hostel data

Spent 7 of Agoda's 500-request/month quota and 5 of Booking's 50, all on 2026-09-04, mostly
searching Vienna since it has real, well-known hostels to check against.

**Agoda has no coordinate search at all.** Its RapidAPI wrapper (`agoda-com.p.rapidapi.com`,
four Hotels & Homes endpoints total: `auto-complete`, `overnight-stays/search`,
`overnight-stays/get-filters`, `detail`, `get-prices`) takes a free-text `location` string.
Passing `latitude`/`longitude` instead returns `{"status":false,"message":"The location
cannot be empty"}` — checked live, not assumed. The stays/agoda.ts adapter reverse-geocodes
through Nominatim (free, keyless, CORS `*`) to turn a coordinate into a place name before
ever calling Agoda, then re-applies the caller's radius itself against each result's own
coordinates, since Agoda's search has no radius concept to honour in the first place.

That workaround has its own real limitation: Nominatim returns the administrative area that
literally contains a point, not the nearest well-known city. Vienna International Airport
(48.1103, 16.5697) reverse-geocodes to **"Fischamend"** — a separate town of a few thousand
people that the airport happens to sit inside — never "Vienna", because Fischamend's
municipal boundary, not Vienna's, contains that exact point. Searching Agoda for
"Fischamend, Austria" will surface a fraction of what "Vienna, Austria" would. There is no
keyless, reliable way to ask Nominatim for "the nearest notable city" instead of "the
containing administrative area" — worth a follow-up if it turns out to matter in practice
for connections through other satellite airports.

**Booking's coordinate search is real.** `searchHotelsByCoordinates` takes
`latitude`/`longitude`/`radius` directly and is the one part of this pair that fulfils issue
#10's "search by coordinate and radius" without a workaround. Its only quirk found live:
`radius=5` is rejected as an "Invalid value", `radius=10` is accepted — the true floor sits
somewhere in between, not pinned down more precisely since finding out costs real,
tightly-budgeted quota.

**Both search endpoints price a property once, not per room kind.** Neither Agoda's search
nor Booking's gives dorm/private prices in the same call — getting them means a second,
per-property request (`get-prices` / `getRoomList`). That is the real reason issue #10's two
adapters rank candidates cheapest-first before drilling into any of them, and why Booking's
default is to drill into far fewer candidates than Agoda's: at 50 requests/month, a single
search that drills into five properties is a tenth of the whole month gone.

**The hostel data itself: better than expected on Agoda, unverified on Booking.** A plain
Agoda search for "Vienna, Austria" surfaced 49 properties, and its `accommodationType` field
correctly picked out seven real hostels among them by name (a&o Wien Hauptbahnhof, Wombat's
City Hostel Vienna Naschmarkt, St Christopher's Vienna, Do Step Inn Central, Vienna
Boutique - Premium Hostel, Stadtaffe - Chic Hostel VIE, a&o Wien Stadthalle) plus one capsule
hotel — a genuine, useful signal for finding hostel inventory in the first place.

Drilling into Wombat's (`get-prices`, propertyId 417108) is where it gets worse. Its 13 real
room types include four mixed dorms (4/6/8-bed) and, encouragingly, two actual **female-only
dorm variants** ("1 Bed in 6 Bedded Female Room Ensuite", "1 Bed in 4 Bedded Female Room
Ensuite") — exactly the inventory issue #10 needs flagged. But:

- `isDormitory`, the one field that should make this easy, was **`false` on all 13 room
  types**, including the ones literally named "N-Bed Dormitory". Wrong on every row, not
  occasionally wrong. stays/agoda.ts classifies from the room name instead and gives this
  field no weight at all — see agoda-mapper.ts's `classifyAgodaRoomKind`.
- Some rooms are named "4 Bed Private Dorm" / "Private 6 Bed Dorm Room" — a private room
  with bunk beds, booked and priced as one whole unit (~130-185 EUR/night) alongside actual
  per-bed dorm beds (~30-40 EUR/night) at the same hostel. Classifying by "contains the word
  dorm" would report a private room's price as a dorm bed's price — roughly 4-5x too high.
  The mapper checks for "private" first and lets it win regardless of what else is in the
  name.

Booking's `getRoomList` has its own real `is_dormitory` field — genuine site-wide schema,
not a broken flag like Agoda's same-named one — but the only room list actually pulled
live (Ibis Vienna Airport, an ordinary hotel with no dorm rooms) correctly read `0` for its
Standard/Superior Twin Rooms. Whether it reads `1` for a real dorm room, and whether Booking
has any dedicated female-only-dorm signal at all, was **not verified live**: the 50-request
budget ran out on confirming the coordinate search and the room-list shape itself. This is
a real gap, not a guess papered over — stays/booking.ts's `classifyBookingRoomKind` trusts
`is_dormitory` for now and falls back to the same name-matching Agoda needed, but that trust
is unearned until someone spends a Booking request confirming it against an actual hostel.

**Verdict:** Agoda's hostel and female-dorm coverage for a well-known city is real and
better than the issue's "expect it to be poor" warning suggested, once you stop trusting its
own `isDormitory` flag and read room names instead. Booking's dorm handling is structurally
promising (a real, non-broken-looking field) but unconfirmed. Both need re-checking against
more cities before either is trusted for a booking a traveller actually relies on.

### Issue #65 follow-up: satellite-airport geocoding fixed for the common case, Booking's dorm flag still unverified

Two threads from the section above, followed up on 2026-09-04.

**Agoda's satellite-airport problem is fixed where this app's own data already knows the
answer, not fixed everywhere.** The fix is not a smarter geocoder call. `stays/agoda.ts`
skips reverse-geocoding entirely when the coordinate is a known airport:
`data/airports.ts` (issue #11) already carries OurAirports' own municipality field for
every scheduled-service airport, and the new `geocode/airport-city.ts` reads it directly, at
zero request cost. Checked live against eight airports on 2026-09-04:

| Airport | OurAirports city field | Resolves to |
|---|---|---|
| VIE (Vienna) | "Vienna" | Vienna, Austria — fixed |
| CIA (Rome Ciampino) | "Rome" | Rome, Italy — fixed |
| CRL (Brussels South Charleroi) | "Charleroi" | Charleroi, Belgium — fixed (Charleroi is genuinely CRL's host city, not a Brussels rebrand) |
| GRO (Girona-Costa Brava) | "Girona" | Girona, Spain — fixed |
| LTN (London Luton) | "Luton, Luton" | Luton, United Kingdom — fixed once the duplicate is collapsed |
| STN (London Stansted) | "London, Essex" | London, United Kingdom — fixed |
| BGY (Bergamo, one of Milan's satellites) | "Orio al Serio (BG)" | Bergamo, Italy — fixed by #136, was "Orio al Serio, Italy" |
| MXP (Malpensa, Milan's other satellite) | "Ferno (VA)" | Milan, Italy — fixed by #136, was "Ferno, Italy" |

Six of eight resolved correctly on the day this was written, VIE included, which is the
exact case this issue was filed over. The two Milan misses were a real gap, not an
oversight: OurAirports' municipality names the literal small comune each airport sits in,
never "Milan". Closing it needed the hand-curated airport-to-city table this issue itself
named as the fallback, and **issue #136 built it**: `src/lib/data/airport-city-names.ts`.

That table now decides `Airport.city.name` for the whole app, so it fixes the name printed
on a result card, the connection-city filter chips and the empty-results copy at the same
time as the label Agoda searches by. `geocode/airport-city.ts` no longer massages the value
it reads; it reads the one this app already decided. The table's own header explains why a
marketed name (Girona sold as "Barcelona", Beauvais as "Paris") stays searchable without
ever being displayed, which is the distinction that kept CRL as Charleroi in the row above.

**The admin-level heuristic this issue asked about was tried and rejected.** Transitous's
`areas[]` trail (`adminLevel` plus `unique`/`default` flags, added by issue #64) looked like
a way to climb past the immediate containing municipality to something more city-sized.
Tested live against VIE, BGY, CIA, STN, LTN, CRL, GRO, MXP and LIN: it needs a different
number of levels climbed for each one (0 for LTN, which has no satellite problem to begin
with, 1 for BGY and CRL, 2 for GRO), actively breaks LTN if applied blindly (jumping straight
past "Luton" to "England"), and can never produce "Vienna", "London" or "Milan" for VIE, STN
or MXP. In each of those three, the marketed city is not an administrative ancestor of the
containing municipality at any level. Vienna, London and Milan are disjoint neighbouring
jurisdictions, not parents of Fischamend, Uttlesford or Ferno, so no amount of climbing the
same point's own hierarchy produces a name that was never in it. `geocode/airport-city.ts`'s
header has the full transcript this conclusion rests on. This heuristic is not implemented
anywhere in this codebase and should not be reintroduced as a general fix without solving
that structural problem first.

**Booking's dorm flag remains exactly as unverified as the section above left it.**
Confirming or correcting `is_dormitory` needed a live RapidAPI request against a real
hostel's `getRoomList` (Wombat's City Hostel Vienna, the same property already checked on
the Agoda side), and no RapidAPI credential was available to the environment this follow-up
ran in. Zero Booking requests were spent, on top of the 5 already spent under issue #10.
`stays/booking-mapper.ts`'s `classifyBookingRoomKind` still trusts `is_dormitory` as a real
signal, OR'd with name matching for the female-only case Booking has no dedicated field for.
Whoever picks this back up needs an owner-provided key with an active Booking subscription
and can spend up to 8 requests against Wombat's `hotel_id` (417108 on Agoda; Booking's own
id for the same property was not looked up) or a similar hostel to settle it one way or the
other.

### Kiwi.com Cheap Flights is subscribed but its own backend is down

**Not the same thing as "Kiwi.com's public API" near the top of this file.** That one is
Kiwi's own keyless GraphQL backend and works; this one is a third party's RapidAPI listing
that resells Kiwi data, and its implementation is offline. Same brand, unrelated fates.


Subscribing worked exactly as documented above: BASIC is $0/month, 300 requests/month hard
limit (the most generous flight quota of any provider in this table), 1000 requests/hour,
no payment method demanded. That is not the problem.

Every call this project made to either of the listing's two endpoints (`/one-way` and
`/round-trip`), after subscribing with a real key, returned:

```
HTTP 402  {"error":{"code":"402","message":"Payment required"}}
x-vercel-error: DEPLOYMENT_DISABLED
```

`x-vercel-error: DEPLOYMENT_DISABLED` is Vercel's own header for a serverless deployment its
owner has taken offline, and a genuine `x-rapidapi-request-id` came back alongside it, so
RapidAPI's gateway really did forward the request to the listing owner's backend, which
answered with its own outage. This is not a bad key, not a subscription problem, and not
this project's mistake: it is a third-party API whose implementation is currently dead.

The `src/lib/providers/flights/kiwi.ts` adapter (issue #51) is built and tested against
this listing's documented request shape (RapidAPI's own generated code snippets, which are
static regardless of whether the backend answers). Its response-shape types are
reconstructed from Kiwi's historical public search API schema instead of a captured live
payload, because no live payload was ever obtainable. Re-verify those types against a real
response before trusting this adapter in production — see that file's header comment.

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

## Hostelworld's own backend: keyless, CORS-open, and the bed price

Same shape of answer as Kiwi's public endpoint, one leg later. `docs/ACCEPTANCE.md`
condition 3 is "A bed is priced into the total", and until this it could only pass for
someone who had paid: Agoda and Booking both come through RapidAPI, both are
`needsKey: true`, so a visitor with no key got "No bed priced for this stopover" on every
result. Adapter in `providers/stays/hostelworld.ts`.

Everything below was measured on 2026-09-04 with `tools/probe-cors.mjs`, from a real page
origin, not from curl.

Measured twice, from both schemes, because the site it has to work on is https and every
earlier measurement was not. From `http://127.0.0.1:8801` and again from a document at
`https://example.com`, all three routes resolved `type: "cors"`, `status: 200`, with
`Access-Control-Allow-Origin: *` on the wire and a readable body. No `OPTIONS` appears in
either request log: the calls carry no headers, so they are simple requests and there is no
preflight to pass.

### The two hosts do not have the same access rules, and the obvious one is worse

Hostelworld serves the same `/2.2` API from two places.

| Host | Anonymous request | CORS | Preflight |
|---|---|---|---|
| `prod.apigee.hostelworld.com/legacy-hwapi-service/2.2` — what the website calls | `401`, no CORS headers | echoes the origin, `allow-credentials: true` | `allow-headers: *`, `max-age: 86400` |
| `api.m.hostelworld.com/2.2` — the mobile host | **`200`** | `Access-Control-Allow-Origin: *` | none needed |

So the price call goes to `api.m`, anonymously, with no custom headers at all: a simple
CORS request with no preflight, on the one path this app walks on every search. The probe
resolved `type: "cors"`, `status: 200`, 24580 bytes of real price-sorted London rates.

```
GET https://api.m.hostelworld.com/2.2/cities/{cityId}/properties/
      ?currency=EUR&date-start=2026-10-09&num-nights=3&guests=1
      &per-page=30&show-rooms=1&sort=price
```

Three parameters are load-bearing, each settled by measurement rather than by reading:

- **`show-rooms=1` is mandatory.** `show-rooms=0` is rejected with `400` and
  `{"description":[{"code":"90597","message":"show-rooms should be positive integer"}]}`.
  It is also the only place a female-dorm price exists.
- **`sort=price` is honoured; `order-by=price` is silently ignored.** Both were sent and
  only one changed the order. It matters because `per-page` truncates: default ranking put
  a 39.68 dorm first while the city's cheapest was 19.07.
- **`per-page=30` is about 53 KB gzipped** (533 KB uncompressed). Omitting it returns the
  whole city, 74 properties for London.

Currency: EUR, USD and GBP confirmed honoured, and EUR is what an omitted `currency`
returns. An unsupported code returns `400` with Hostelworld's own
`{"description":[{"code":"90593","message":"please pass valid currency three letter
code"}]}`, which the adapter surfaces verbatim.

### `guests` filters availability and never scales a price

Re-measured on 2026-09-05 for issue #206, which asked for this to be settled rather than
inferred, because a party quoted a third of what its beds cost is a wrong price nobody would
notice. London (city 3), 9 to 12 October 2026, EUR, at `guests` of 1, 2, 3, 4 and 6.

Every property-level price and every room-level price came back identical at all five guest
counts. What moved is `pagination.totalNumberOfItems`: 74, 74, 71, 69, 66. The server does
read `guests`. It decides which properties can host the party and it never touches a number.
Asked the same way, `/2.2/properties/330521/availability/` returned the same 63996 bytes at
`guests=1` and at `guests=3`, differing only in the order of the entries in its
`promotions` array.

So the figure is the rate for one unit of inventory. Which unit, per room kind, is legible
in `rooms` at Rest Up London for those dates. Room-level `lowestPricePerNight`, in EUR:

| Dorm | Rate | Private | Rate |
|---|---|---|---|
| 4-bed | 15.87 | twin, shared bathroom | 35.39 |
| 6-bed | 14.02 | twin, ensuite | 39.49 |
| 6-bed ensuite | 16.29 | double, ensuite | 42.93 |
| 8-bed | 12.82 | 4-bed | 61.85 |
| 8-bed ensuite | 14.66 | 6-bed, shared bathroom | 81.32 |
| 10-bed ensuite | 13.02 | 6-bed ensuite | 94.52 |
| 12-bed ensuite | 12.32 | | |

A private is the whole room, and the arithmetic says so on its own. The 4-bed private asks
61.85 against 4 x 15.87 = 63.48 for the same four beds sold one at a time, the 6-bed asks
81.32 against 6 x 14.02 = 84.12, the 6-bed ensuite asks 94.52 against 6 x 16.29 = 97.74.
Every private lands within 3.5% of its own beds sold separately, which is not what a
per-person figure would do.

Hostelworld also says it in its own words, on every private room at
`/2.2/properties/{id}/rooms/`:

> In order to secure a Private Room, you will need to book the entire room. For example 3
> persons booking a 4 bed private room will need to select and pay for 4 persons if they
> wish to have a private room.

**A dorm rate is one bed, so it is per person. A private rate is one room, so it is per
party.** Neither moves with `guests`.

Re-run independently at 03:40 the same morning, on the same city and dates, because #206
said to settle it with evidence and one agent's table is not that. Same five guest counts,
same answer: every property-level dorm and private rate byte-identical across 1, 2, 3, 4
and 6, `totalNumberOfItems` again 74, 74, 71, 69, 66. Prices had moved by pennies overnight
(Rest Up London's dorm average read 19.59 rather than 19.07), which is the useful part: the
inventory repriced and the invariance did not budge. Safestay Kensington Holland Park makes
the private-room half legible in one property, at `guests=1`:

| Room | Rate | Beds x that property's cheapest dorm |
|---|---|---|
| Twin private, shared bathroom | 79.03 | 2 x 19.10 = 38.20 |
| 9-bed private ensuite | 203.52 | 9 x 19.10 = 171.90 |
| 12-bed private, shared bathroom | 248.92 | 12 x 19.10 = 229.20 |
| 15-bed private ensuite | 306.37 | 15 x 19.10 = 286.50 |

A private that tracks its own bed count that closely, from 2 beds to 15, is a room rate.
A per-person rate of EUR 306.37 a night in a hostel is not a thing.

That is not what `search/resources.ts` consumes: "`Stay` is priced as one flat per-night
figure for the whole party." Agoda and Booking satisfy it for free, since both send
`adults` and are quoted for that many people. Hostelworld does not, so
`hostelworld-mapper.ts` multiplies the dorm and female-dorm figures by the party size. A
unit of dorm inventory is one bed and three travellers need three. A private is one room
and is taken as it comes. Left unmultiplied, a party of three would have been quoted a
third of what the stopover costs them, and the acceptance trip could never have shown it
because that trip is one traveller.

`Stay.pricePerPersonPerNight` carries the per-bed rate the mapper started from, so issue
#206's per-person figure is the number Hostelworld quoted rather than a division of the
party total. A private, an Agoda quote and a Booking quote set nothing there, because
splitting a room between the people in it would print a figure no provider ever gave. See
`src/lib/domain/stay.ts`.

### The price field that is a trap

`lowestDormPricePerNight` is the cheapest SINGLE night of the stay, a "from" teaser.
`lowestAverageDormPricePerNight` is the stay's real per-night cost. At Rest Up London for
9-12 October they read 12.32 and 19.07. Since a `Stay` is consumed as
`nights × pricePerNight`, reading the teaser under-reports a three-night bed by 35% and
presents it as a total. Both were confirmed per-night rather than per-stay by asking for a
single night, where the two collapse to the same value.

### City resolution is geographic, not textual

`/cities/{id}/properties/` is keyed by city; `StaySearchQuery.near` is a coordinate. The
bridge is Hostelworld's own geography, and it is keyless too:

```
GET https://api.m.hostelworld.com/2.2/continents/{1..6}/countries/
```

Every country with its full city list and **real coordinates**. Six requests cover the
world: 167 countries, 3541 cities, 83 KB gzipped (North America 11.5, South America 12.4,
Europe 29.0, Asia 21.1, Oceania 3.8, Africa 5.0). The adapter caches the flattened result
for a month, so a warm search spends exactly one request and a cold three-stopover search
spends nine. Continent ids are fixed at `1=North America, 2=South America, 3=Europe,
4=Asia, 5=Oceania, 6=Africa`; `7` answers `400`. `/2.2/cities/` and `/2.2/countries/` are
not indexes — both answer as though the id were 1, which is Cork.

Matching is by distance first and by name only as a tie-break, and both halves are needed:

- **Distance alone fails.** The nearest Hostelworld city to London Gatwick is "Gatwick",
  2 km away, then Crawley 3.6, Guildford 28.6, Lewes 33.5, Brighton 35.2 — London is
  SIXTH, at 39.3 km. Manchester Airport's nearest is Macclesfield, not Manchester.
- **Name alone fails.** Hostelworld has a London in Ontario and puts Brazil's Boa Vista
  ahead of Cape Verde's.

So the adapter prefers, among cities inside the search radius, the one this app already
decided the airport serves (`geocode/airport-city.ts`), and falls back to the nearest when
Hostelworld has never heard of that name. Checked against all three of the acceptance
search's own stopovers: LGW picks London (3), MAN picks Manchester (171), BHX picks
Birmingham (718), PFO picks Paphos (21908).

**Preferring it was not the bug; stopping at it was.** Issue #204 is the owner reporting
hostels in Horley, thirty minutes on foot from Gatwick, where the app showed him beds 40 km
up the line in London. The endpoint was never what stopped us reaching them: Hostelworld's
own city 3671, named "Gatwick", has region `Horley` and holds The Gatwick White House Hotel
on Church Road and The Lawn Guest House on Massetts Road, both 2.8 km from the terminal,
with Crawley (2582) adding Little Foxes Hotel at 2.9 km. Gatwick was already SECOND on the
candidate list. `searchStays` returned as soon as London answered, so it was never asked.

The adapter now asks every candidate city and merges the results. Which of them the
traveller ends up with is `search/resources.ts`'s call, not this file's.

**No radius fixes this**, which is worth stating because it is the obvious thing to reach
for. LGW to London is 39.3 km and MXP to Milan is 39.7 km, so any radius tight enough to
drop the London bed also throws Milan away. PR #212 measured exactly that before deferring
it here.

**There is no purely geographic search to switch to either.**
`/2.2/properties/?latitude=&longitude=` answers `400` `invalid property-group-id`, and
`/2.2/search/` and `/2.2/cities/{id}/nearby/` both `404`. `latitude`/`longitude` plus
`sort=distance` does work, but only **within one city**: city 3 sorted from Gatwick returned
34.5, 36.3, 37.8, 37.9, 38.0 km ascending against 38.9, 39.4, 48.3, 44.2, 38.3 unsorted —
every one of them still a London property, because Horley's belong to city 3671. Sorting by
distance cannot reach a city you did not ask for. So the city id stays mandatory and asking
the near city is the only route to a near bed.

For an airport with no city inside the radius at all, nothing changes: the adapter returns
an honest empty and the stopover reads "No bed priced".

**What it costs.** Six index requests, cached a month, then three price calls per stopover
instead of one. Measured 9 to 14 on the acceptance search's three stopovers, and 10 to 18 on
`pnpm qa`'s four-candidate scenario. `tests/qa/budget.ts` carries the ceiling and the
arithmetic. Three candidates is the smallest window that holds both the walkable town and
the real city: two would reach Horley but lose Milan, whose name this app writes as
"Ferno (VA)" so nothing matches it and it only arrives third by distance.

### The autocomplete route, tried and rejected — do not reach for it again

The first version of this adapter resolved cities through
`prod.apigee.hostelworld.com/autocomplete-service/v1/autocomplete/web/?text=London`. It
passed every unit test and failed on the real page:

```
Access to fetch at 'https://prod.apigee.hostelworld.com/autocomplete-service/...'
from origin 'http://localhost:4188' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

That host reflects `*` **only to hostelworld.com itself**. `curl` reported `200` with an
`api-key` header throughout, which is precisely the trap `tools/probe-cors.mjs` exists to
catch and precisely why the rule at the top of this file says to measure CORS from a
browser. Its data was worse anyway: every suggestion carries
`{"latitude": 0, "longitude": 0}`, so it could not have disambiguated a city by geography
even if it had been reachable, and `text=London, United Kingdom` returns "Sorry, we cannot
find anything that matches your search term" because Hostelworld files it under England.

### What was rejected before this, and why

Measured from a browser page origin, never from curl. The **Confirmed** column says who
saw it: `browser` means a `tools/probe-cors.mjs` run on this branch, on the date given.
Everything else is a single agent's note carried forward and **not independently checked**,
which is marked rather than dropped because knowing where a claim came from is the point of
this table. One claim from that unchecked set has already turned out wrong: it reported
`per-page` and `sort` as ignored, and both are honoured.

| Source | Observed | Confirmed | Verdict |
|---|---|---|---|
| `engine.hotellook.com/api/v2/cache.json` | `TypeError: Failed to fetch`, "No 'Access-Control-Allow-Origin' header is present" | browser, 2026-09-04 | Dead. Travelpayouts closed Hostellook in October 2025 |
| `engine.hotellook.com/api/v2/lookup.json` | `TypeError: Failed to fetch`, no ACAO | browser, 2026-09-04 | Same shutdown |
| `data.xotelo.com/api/rates` | keyless, real OTA rates, **no ACAO header at all** | browser, 2026-09-04 | The painful near-miss. Perfect but for CORS |
| ZenHotels / Ostrovok `hotel/search/v2/site/serp` | no ACAO | browser, 2026-09-04 | Server-side only |
| `www.booking.com/dml/graphql` | preflight blocked, "No 'Access-Control-Allow-Origin' header" | unverified | Origin allowlist, not a reflector. A browser cannot spoof Origin |
| `www.agoda.com` GraphQL | POST reflects the origin but the preflight returns `204` with zero CORS headers | unverified | Dead end |
| Trip.com `soa2/…/fetchHotelList` | preflight passes, then `430` from their anti-bot | unverified | Dead end |
| Expedia, Hotels.com, Trivago, MakeMyTrip | no CORS, plus Akamai `403`/`429` | unverified | Dead end |
| Amadeus self-service | host is NXDOMAIN | unverified | Reported decommissioned 17 July 2026 |
| Numbeo | `ACAO: *` but a paid key | unverified | Key-gated, and cost-of-living rather than bookable prices |
| `overpass-api.de` | `ACAO: *`, keyless | unverified | Hostel *locations* only; `charge`/`fee` tags are free text |
| Eurostat `prc_ppp_ind` | `ACAO: *`, keyless | unverified | A country-level price index. An honest labelled estimate at best, never a bookable price |

None of the unverified rows is load-bearing: the adapter that shipped does not depend on
any of them being dead, only on `api.m.hostelworld.com` being alive, which is the one row
measured hardest.

### Limits, stated plainly

1. **This is an undocumented app backend, not a published API.** No ToS grant, no stability
   promise. The `2.2` versioning suggests it survives because the mobile apps still need it.
   Every field is re-validated in `hostelworld-mapper.ts`, and a failure degrades to "no bed
   priced" rather than failing a search.
2. **Hostels and budget hotels, not the whole market.** In a city Hostelworld does not
   cover, this returns nothing. Agoda and Booking stay registered for anyone with a key.
3. **Female-dorm prices come from a different field** than dorm and private, and are a real
   bookable rate that is not guaranteed to be the cheapest female bed at the property. That
   asymmetry is safe in one direction only, and it is the safe one — see
   `hostelworld-mapper.ts`'s `mapPropertyToStays`.
4. **No structured field for a property-wide gender restriction**, the same gap Agoda and
   Booking have. A women-only hostel is detected from its name through the shared
   `women-only-name.ts` (#207), which is a name check because nothing better is on offer.

## Keyless sources

These work with no key, no signup and no quota, which means the app does something useful
the first time it loads.

**Hostelworld's own backend** is where the bed price comes from, and the reason a stopover
has a total at all without a key. Full evidence in its own section above; adapter in
`providers/stays/hostelworld.ts`.

**Kiwi.com's public GraphQL endpoint** is the aggregator of the set, and the one that makes
an arbitrary route work at all. Full evidence in its own section near the top of this file;
adapter in `providers/flights/kiwi-public.ts`.

**Ryanair** publishes fares directly. Real prices, flight numbers, local times, plus a route
graph — **for Ryanair's own network only**. Which endpoints, and why it takes two of them
for the fares, is the next section down.

An earlier version of this line said "direct destinations from any airport", which is wrong
and cost real time. Counted from the bundled snapshot issue #145 now ships
(`data/ryanair-network.generated.json`): **224 origins**, and Boa Vista is not one of them.
Neither is Sal or Praia — Ryanair does not serve Cape Verde at all.

Which half of the route that breaks is worth being precise about, because it is not the
obvious one. Ryanair reaches Pafos from plenty of airports (AMM, ATH, BER, BGY, BHX, BTS,
BUD, BVA, CGN, CHQ and more), so the inbound leg was always answerable. It is the outbound
leg from an airport outside the network that returns nothing, and one missing half is enough
for the connection graph to produce no candidate at all.

It is one airline, so it is not a substitute for an aggregator. Its real value is as
ground truth: these fares come from the airline itself, so when an aggregator quotes a
different price for the same flight number, the aggregator is wrong.

#### Fares are a calendar plus a timetable, and it takes both (issue #137)

`farfnd/v4/oneWayFares` is a fare *finder*, not a schedule. Pinned to one route it returns
exactly **one** fare for the whole date range, however wide the range, and `limit`/`offset`
do not change that (measured 2026-09-04, `size: 1` with and without). One fare per leg is
one date pair per stopover, which is why the flight picker used to have a single row in it.

The same API answers per day. Keyless, CORS-open, one request per calendar month:

```
https://services-api.ryanair.com/farfnd/v4/oneWayFares/BCN/BGY/cheapestPerDay?outboundMonthOfDate=2026-10-01&currency=EUR
```

Its rows are `{day, departureDate, arrivalDate, price, soldOut, unavailable}` and nothing
else. **No flight number, no carrier code, not even the airport objects.** Two traps in
that response, both measured rather than guessed:

- It always returns the whole calendar month, whatever range you ask about, so a caller
  has to clip to its own window or it will offer dates nobody asked for.
- A route Ryanair does not fly answers `200` with a month of `unavailable: true` rows, not
  a `404`. BCN→OTP and BVC→LGW both do. Ignore that flag and you have invented a month of
  flights on a route with no service, which docs/ACCEPTANCE.md ranks ahead of every feature
  as a bug.

The flight's identity comes from the timetable, same host, also keyless:

```
https://services-api.ryanair.com/timtbl/3/schedules/BCN/BGY/years/2026/months/10
```

`{month, days: [{day, flights: [{carrierCode, number, departureTime, arrivalTime}]}]}`,
listing only days that have a flight, and `days: []` for a route not flown. Joined to the
fares on the departure minute: across 10 routes and 235 priced days on 2026-09-04, every
priced fare matched a scheduled departure, arrival times included.

**`carrierCode` is not always `FR`.** STN→DUB in October 2026 mixes `FR` and `RK` (Ryanair
UK) rows in the same month. Take the carrier from the feed; hardcoding "Ryanair" puts an
airline's name on a flight it does not operate.

So a leg-month costs two requests where it used to cost one. The timetable is cached for a
week against the fares' five minutes, because a schedule moves seasonally and a price moves
hourly, and both are keyed by calendar month rather than the search's exact dates, so
nudging a date is a cache hit rather than a fresh sweep.

#### The route graph is one request, not one per airport (issue #121)

Measured 2026-09-04 on BCN to OTP, in an isolated Chromium with `flights-cache` deleted
(`tools/probe-ryanair-requests.mjs`). Production answered a cold search with **97
requests**; the same code built and served locally answered with **140**. The gap is not
noise in the route graph, which cost the same 80 requests either way: it is the fare
sweep. Issue #115 prices up to 24 candidates when the geography-ranked top 6 produce
nothing, so a search where the top 6 happen to work costs 12 fare lookups and one where
they do not costs 48. Comparing two runs that took different paths through that is how you
talk yourself into a win you did not get, which is why the probe prints the split.

Against the local 140-request run, endpoint by endpoint:

| | before | after |
|---|---|---|
| `routes/en/airport/{IATA}`, one per candidate airport | 80 (72 × `200`, 8 × `404`) | **0** |
| `airports/en/active`, the whole network | 12 | **1** |
| `farfnd/v4/oneWayFares` | 48 | 48 |
| **total, cold cache** | **140** | **49** |
| same search again | 0 | 0 |

(Issue #137 then replaced that `oneWayFares` row with a `cheapestPerDay` request and a
`timtbl/3/schedules` request per leg-month — see the fare section above for the numbers.)

Same three itineraries found. The twelve active-airports calls were one table fetched
twelve times over, because a dozen concurrent fare searches all missed the same cold cache
and nothing deduplicated them.

The per-airport endpoint was the wrong shape for the data. This one call carries the whole
network:

```
https://www.ryanair.com/api/views/locate/3/airports/en/active
```

278 KB, 224 airports, and each one's `routes` array holds every destination it serves,
written as `airport:STN` alongside `city:`, `country:`, `region:` and `connectingFlight:`
facets. A handful of legs carry a marketing carrier after a pipe (`airport:PMO|Air Malta`,
the only two in the feed) next to a plain duplicate, so split on `|` and de-duplicate.

**The two endpoints agree, checked rather than assumed.** Both were called for the same
twelve airports on 2026-09-04 and the destination sets compared:

| Airport | per-airport endpoint | `routes` in the bulk response |
|---|---|---|
| BCN | 64 | 64, identical set |
| STN | 162 | 162, identical set |
| DUB | 122 | 122, identical set |
| BGY | 108 | 108, identical set |
| MLA | 71 | 71, identical set |
| PMO | 53 | 53, identical set |
| OTP | 43 | 43, identical set |
| PFO | 39 | 39, identical set |
| WRO | 53 | 53, identical set |
| AHO | 23 | 23, identical set |
| AAR | 8 | 8, identical set |
| LGW | 4 | 4, identical set |

750 edges, no airport in one and not the other, in either direction. And every airport
known to `404` — ALG, DUS, EVN, IST, LED, plus the reference route's BVC, RAI and SID —
is absent from the bulk response, which is the same statement.

The 404 the per-airport endpoint gave for ALG, DUS, EVN, IST and LED is real information,
not a failure: it means "not in my network". Those airports are simply absent from the
active-airports response, which is the same answer for free. Since that response
enumerates the entire network, absence IS the answer, and nothing has to spend a request
rediscovering it.

So the per-airport endpoint is gone from this app. The network is snapshotted weekly into
`src/lib/data/ryanair-network.generated.json` by `scripts/fetch-ryanair-network.mjs`
(`.github/workflows/ryanair-network.yml`), which is the floor a cold search reads from, and
the adapter refreshes the same data live at most once a day, deduplicated across a fan-out.
Every remaining request a search makes to Ryanair is a fare it actually intends to price.

**On the rate limit itself.** Issue #121 asked for the actual number and it is still not
known, because finding it means deliberately hammering a free API that owes us nothing.
Nothing was throttled at 140 requests in a burst from a quiet IP, and a search now sits
well under half that, so the question stopped being urgent. If it has to be answered later,
the honest way is one deliberate measurement, written down here.

#### Fares are cached for an hour, and shown with their age (issue #147)

Ryanair's fare-finder sends `Cache-Control: max-age=60, s-maxage=300`, and this app used to
take the 5 minutes literally. The owner reported what that felt like: *"it doesnt seem like
that because loading takes a lot of time every time i reload"*. Measured on BCN→OTP: a
reload 30 seconds after a search cost 0 requests and painted in 0.3s, and the same reload
5.5 minutes later cost 48 fare requests. Coming back to a search after lunch was a cold
search.

The header is about Ryanair's CDN economics, not about how fast its prices move, so the
adapter now holds a fare for an hour. Past that, the cached answer is still served
immediately and refreshed behind the page rather than discarded — an expired entry used to
be thrown away, sending the user to the network for prices the app was already holding.
Every fare carries the instant it was really read, in `ProviderSource.fetchedAt`, which the
result card already renders as "fetched 40 minutes ago". A price that old, visibly that
old, beats a spinner.

#### Ryanair does not tell us when it last repriced a fare (issue #170)

Two different instants, and only one of them is knowable here. `fetchedAt` is when *we*
asked. When *Ryanair* last moved the price is a different number, and it is the one a
traveller actually cares about: a fare retrieved ten seconds ago may have been set eight
hours ago.

The issue was filed against `RyanairFare.outbound.priceUpdated`, a typed-but-never-read
field on the old fare finder. That endpoint and that field both left the codebase with
issue #137. The current fare source carries nothing equivalent, and I checked rather than
assumed. Measured live on 2026-09-04, the union of keys across all 31 rows of
`farfnd/v4/oneWayFares/BCN/STN/cheapestPerDay`:

```
day, arrivalDate, departureDate, price, soldOut, unavailable
```

The committed fixture is a verbatim capture of that, not a trimmed one.

Three ways it could have been recovered, all closed:

- **Go back to `farfnd/v4/oneWayFares`.** It still carries `priceUpdated`, still past-dated
  and plausible (re-checked 2026-09-04: it read 3.5 hours behind the clock). But pinned to
  one route it answers `size: 1`, one fare for the whole month, which is exactly why #137
  stopped using it. Its single timestamp could date one of the thirty-one offers the picker
  shows, for a third request per route-month.
- **Read the CDN's `Age` and `Date` headers.** They are on the wire, and a browser cannot
  see them. Neither is CORS-safelisted, and Ryanair's `Access-Control-Expose-Headers` lists
  only `Content-Type, Accept, X-Requested-With, X-File-Name, x-real-ip, Market-Code,
  Market-BasePath, X-AUTH-TOKEN, X-Session-Token, fr-correlation-id`. Confirmed from a real
  cross-origin `fetch()` in Chromium: the only readable headers are `cache-control` and
  `content-type`, and `res.headers.get('age')` returns `null`. With no backend there is
  nowhere else to read them from. This is the same measurement discipline #146 used on the
  RapidAPI quota headers, and the answer here is the negative one.
- **Infer it from `Cache-Control: max-age=60, s-maxage=300`.** That is the CDN's retention
  policy, not a claim about when the price changed. Deriving one from the other invents the
  number.

So the app says what it knows. The result card's badge now reads "Checked 40 minutes ago"
instead of "Priced 40 minutes ago": the first is a fact about us, the second was a claim
about the fare built from a clock that never knew it.

**Transitous / MOTIS** answers the question ordinary flight search cannot: is there
actually a bus at the hour this flight lands, and if not, when is the next one.

```
https://api.transitous.org/api/v1/plan?fromPlace=LAT,LON&toPlace=LAT,LON&time=ISO8601
```

Their terms require a `User-Agent` naming the app with contact details, ask that the
project be open-source and non-commercial, and ask for attribution. Honour all three.
The service is free and run by volunteers.

**MOTIS will route a ground transfer through four flights if you let it** (issue #220).
Asked for the 9.7 km from Birmingham airport to a hostel in Birmingham at 03:00, it
answered with a 21h 27m itinerary flying BHX to Olbia, Rome, Cagliari and Amsterdam, then
a train to Den Haag, a FlixBus to London Victoria and a National Express coach to Digbeth.
The default `transitModes` is `TRANSIT`, and MOTIS's own `openapi.yaml` defines that as
`TRAM,FERRY,AIRPLANE,BUS,COACH,RAIL,ODM,RIDE_SHARING,FUNICULAR,AERIAL_LIFT,OTHER`. So this
adapter sends that list with `AIRPLANE` removed, and the mapper drops an air leg again on
the way in.

Two things to know before touching that parameter. An unrecognised mode name is a hard
`500` with MOTIS's own `enum ModeEnum: unknown value NOT_A_MODE` in the body, so a typo
takes out every transit lookup rather than degrading. And a mode added to `TRANSIT` later
would not be asked for here until someone updates the list, since MOTIS has no "everything
except" form.

**The reason it reaches for a flight is coverage, not a routing bug.** Measured 2026-09-05,
ground modes only, all `200` with an empty `itineraries` array: Birmingham airport to a
Birmingham hostel (9.7 km), Vienna airport to Vienna centre (18.2 km), and Stansted to
central London (48.9 km). The last two answered with six itineraries each when `AIRPLANE`
was allowed, every one of them a flight. Tomorrow's date gives the same empty answers, so
it is not the timetable horizon. Barcelona airport to Plaça Catalunya (12.6 km) is
unaffected either way: the same six bus itineraries, 50 to 62 minutes. Do not read
Transitous's silence on a British or Austrian airport run as this adapter being broken.

**The same server also geocodes** (issue #64), which turned out to matter more for
timezones than for the search form it was originally asked for. Two endpoints:

```
https://api.transitous.org/api/v1/geocode?text=Sagrada%20Familia%20Barcelona
https://api.transitous.org/api/v1/reverse-geocode?place=LAT,LON
```

Both return a bare JSON array of places, each with `name`, `lat`, `lon`, `country`, `tz`
and an `areas` trail (admin regions, broadest first, each flagged `matched` against the
query). Verified 2026-09-04: keyless, `access-control-allow-origin: *`, same host and
terms as `/plan` above.

Numbers print in scientific notation on real responses (`"lat":4.1403983999999994E1`),
not `41.403984`. That is still valid JSON number syntax, so `JSON.parse`/`Response.json()`
already decode it correctly — there is nothing to hand-parse, and the risk is a future
change adding a manual decimal parse that breaks on exactly this shape.

`/geocode` free-text search is genuinely ambiguous by design: "Barcelona" resolves to the
Catalan city, a Venezuelan city, a Philippine one, a Colombian one and a Brazilian one, all
in one response. A UI built on this must show every candidate and let a person choose —
picking the first result silently is wrong roughly as often as it is right.

Searching `/geocode` by IATA code or "`<code>` Airport" is NOT reliable enough to hang a
timezone lookup on: `text=BCN` resolves to a hamlet in the Swiss canton of Fribourg (the
geocoder has no notion that "BCN" means an airport), and `text=BCN Airport` surfaces
airports in Kobe and Naha ahead of Barcelona because "Airport" outweighs a 3-letter code in
its ranking. `/reverse-geocode`, fed an airport's own coordinates (already exact in this
app's OurAirports-derived dataset, `src/lib/data/airports.ts`), sidesteps the problem
entirely: checked against 16 airports spanning every populated continent (BCN, VIE, JFK,
LAX, SYD, DXB, NRT, GRU, JNB, SIN, LHR, ANC, CPT, HND, GIG, AKL) on 2026-09-04, it returned
the correct IANA zone for all 16, DST-observing and half-hour-offset cases included. That
makes it a live replacement candidate for `skyscanner-timezone.ts`'s hand-curated,
silently-rotting IATA table (issue #64 built the capability and proved it works; wiring it
into an existing, shipped adapter was its own follow-up issue, deliberately not bundled
with this one).

**Update, issue #75:** that wiring is done. `skyscanner-timezone.ts` now tries a small seed
table first (no network, kept only for the busiest hubs) and falls through to the live
lookup above for anything else, rather than dropping an offer just because a hand-typed
list never mentioned that airport. Re-running the same 16-airport check while building this
turned up a real gap the original check did not: on 2026-09-04, the same day as the check
above, a fresh `/reverse-geocode` call for **DXB** — Dubai International, one of the
airports this table itself lists as verified — returned an empty array, not a wrong zone
but no result at all. Whether that is a transient service hiccup or a real, narrow coverage
hole in Transitous's own data was not worth spending more of its volunteer-run capacity to
pin down; either way it is the concrete reason the seed table still exists as a fallback
for a short list of busy hubs (DXB included) instead of being deleted outright. The other
15 airports resolved correctly on the same run. A handful of small, remote airports checked
for the same PR (Ushuaia, Wallis Island, Funafuti, Chuuk, Saipan, Nuuk, Easter Island)
mostly resolved correctly too — with the same caveat: Ushuaia's reverse-geocode also came
back empty, and three Pacific airports resolved to a zone that is a real IANA alias of the
"expected" one (identical UTC offset and rules, different canonical name — Pacific/Tarawa
for Funafuti and Wallis, Pacific/Guam for Saipan), not a wrong answer.

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

"Do not hammer it" is enforced in the adapter, and only started working in #213. The
wiki asks for no more than a request a second, and the code kept a `lastRequestAt`
timestamp to honour that — but a dozen concurrent lookups all read the same stale value,
all slept the same 1100 ms and all fired together, so the gap fell between bursts rather
than between requests. `waitForRateLimit` now chains, and a cold search on the acceptance
trip sends its eight requests 1.1 s apart over 7.7 s instead of at once. Measured with
`tools/probe-osrm-requests.mjs`, which prints the count, the repeats, the reversed pairs
and the gaps between sends. Before the fix, five of twelve requests came back refused;
after it, none did.

Each stopover is still two requests, one per direction, and that is on purpose: a drive
from the airport and the drive back are different journeys on a real road network, and
printing one leg's duration for the other would be presenting an estimate as a fact.

**A car route that crosses water can be wrong by a factor of nine, and nothing in the
response says so.** Issue #119. OSRM's car profile routes over ferries, and prices a
`route=ferry` way from that way's own `duration` tag. Where OSM has no such tag it falls
back to roughly 5 km/h, which is a rowing boat. Measured on 2026-09-05 against
`routed-car`:

| route | straight | road | OSRM says | reality |
| --- | --- | --- | --- | --- |
| Athens airport to Naxos town | 156.6 km | 180.0 km | 33h 0m | the Piraeus ferry is about 3h 45m |
| Athens airport to Thira, Santorini | 214.4 km | 268.9 km | 37h 31m | five untagged ferry ways in a row |
| Marseille airport to Ajaccio, Corsica | 333.5 km | 590.0 km | 12h 23m | correct; that way carries a tag |

The response looks entirely ordinary. There is no flag, no warning, and the route's shape
gives nothing away either: Naxos travels only 1.15 times its straight-line distance, a
tighter ratio than an honest drive round a Norwegian fjord. Nor does average speed along
the road help — across fourteen measured pairs, water crossings and dry land alike, every
real route averaged between 38.8 and 70.9 km/h, and Naples to Capri crosses 33 km of open
sea at 40.2 km/h.

The only signal that separates the two is how long the answer takes against the
straight-line distance, which is what `maxPlausibleRoadMinutes` (`domain/transfer.ts`)
judges and where the full table lives. Anything reading an OSRM car duration for a pair
that could have water between it needs that check, or it is quoting a rowing boat.

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

#### The dataset carries its own fetch instant (issue #169)

`expires_at` answers a different question from the one provenance asks. It is
Travelpayouts' claim about its cached fare. "When did we retrieve this file" was not
recorded anywhere, so `search/providers-adapter.ts` filled the gap with
`new Date().toISOString()` at read time, and a dataset compiled into the bundle weeks
earlier reported itself as seconds old.

The generator now writes the instant it actually fetched, and the file is an object rather
than a bare array:

```json
{ "fetchedAt": "2026-09-04T03:17:22.481Z", "routes": [ ... ] }
```

Deriving `fetchedAt` from a row's `expires_at` was rejected. An expiry is not a retrieval,
and turning one into the other is the same invention in a different disguise.

One consequence, taken deliberately: the nightly job now commits on every run, because the
stamp advances even when no price moved. The alternatives were to bump the stamp only when
the data changed, which makes it mean "when this data was last different" and would have to
be renamed to say so, or to leave it stale between changes, which is simply false. The
`routes` array is still sorted, so `git show` on one of those commits still says at a glance
whether a price moved or only the stamp did. `.github/workflows/ryanair-network.yml` already
made the same trade for the same reason.

### What the build-time dataset actually holds, and why it did not save the reference trip

Counted from the committed `data/cheap-routes.generated.json` on 2026-09-04: **1,337 routes
across 47 origins**, which averages a healthy 28 per origin. The average hides the problem.

```
BCN 29   LGW 30   VIE 30   ...   RAI 11   SID 9   BVC 1
```

`/v1/city-directions` returns the cheapest destination per city, and for a thin market it
returns almost nothing. Boa Vista got **one** row — and that row is `BVC → RAI` attributed to
airline `U2` (easyJet) with 2 transfers at EUR 780, which is cached junk rather than a real
Cape Verde domestic flight. Nothing in the whole dataset reaches PFO at all, because the file
is keyed by origin and Pafos is not one of the configured origins.

So the build-time route is real and worth keeping, but it was never going to answer an
arbitrary trip. It covers the origins someone thought to list, at whatever depth
Travelpayouts' cache happens to have, and it carries no timezone, which is why
`search/providers-adapter.ts` deliberately returns no offers from it at all.

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


### Hostel data is weak in both stay providers, measured 2026-09-04

**Superseded as the state of the product, kept as the state of Agoda and Booking.** The
opening claim below — "Hostelworld has no API" — was wrong, and it is what sent two
adapters chasing hostel prices through hotel-first resellers. Hostelworld's own backend is
now this app's baseline for beds ("Hostelworld's own backend", above). Everything after
the first paragraph is still an accurate account of Agoda and Booking, which stay
registered for anyone holding a key.

Hostelworld has no API, so Agoda and Booking carry all hostel coverage between them. Both are
hotel-first and it shows.

**Agoda's `isDormitory` flag is broken.** It reads `false` on rooms literally named "N-Bed
Dormitory". Classification therefore runs on the room name, with a guard against "Private N Bed
Dorm", which is a whole private room at four to five times the price of a bed in one.

**Booking returns no rooms at all for a hostel.** Querying `getRoomList` for Wombat's City
Hostel Vienna (`hotel_id=274237`) on 2026-10-06 returns `status: true, message: "Success"` with
an **empty `block` array** and no `is_dormitory` field anywhere in the response. Not an error, no
message, simply nothing. Whether that is a sold-out date, a parameter we have wrong, or the
endpoint being unreliable for this property class is unknown.

`is_dormitory` also does not appear in the `searchHotels` response, only in the room list, so
there is currently no confirmed path to dorm pricing through Booking at all.

**Consequence for the product.** A dorm bed is the cheapest option in a stopover city and is what
makes the "free trip" arithmetic work, so this is not a cosmetic gap. Until it is solved, prefer
Agoda with name-based classification, and be explicit in the UI about what kind of bed a price
refers to rather than implying a dorm rate when only a private room was priced.
