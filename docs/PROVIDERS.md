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
| `agoda-com.p.rapidapi.com` | 200 | reflects the request origin |
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
| Kiwi.com Cheap Flights (flights) | `kiwi-com-cheap-flights.p.rapidapi.com` | **300 / month**, hard limit, 1000/hour rate | yes |
| Agoda (stays) | `agoda-com.p.rapidapi.com` | **500 / month**, hard limit | yes |
| Booking.com (stays) | `booking-com15.p.rapidapi.com` | **50 / month**, hard limit | yes |
| Rome2Rio (transport) | `rome2rio.p.rapidapi.com` | unknown | **no, see below** |

Agoda's 500 is the outlier and worth exploiting. Stay lookups can be relatively generous
while flight lookups must be hoarded, so do not apply one budget policy across all providers.

Provider slugs, since finding these cost real time:
`rapidapi.com/apiheya/api/sky-scrapper`, `rapidapi.com/ntd119/api/flights-sky`,
`rapidapi.com/ntd119/api/agoda-com`, `rapidapi.com/DataCrawler/api/booking-com15`,
`rapidapi.com/emir12/api/kiwi-com-cheap-flights`. The header search box finds Kiwi's
listing (`/search?term=kiwi`); the bare `/search/<term>` path drops the query string and
returns an unfiltered list, which cost real time to notice.

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
| BGY (Bergamo, one of Milan's satellites) | "Orio al Serio (BG)" | Orio al Serio, Italy — still wrong |
| MXP (Malpensa, Milan's other satellite) | "Ferno (VA)" | Ferno, Italy — still wrong |

Six of eight resolve correctly, VIE included, which is the exact case this issue was filed
over. The two Milan misses are a real, documented gap, not an oversight: OurAirports'
municipality field names the literal small comune each airport sits in, never "Milan", and
nothing else in this app says otherwise. Closing that specific gap needs a hand-curated
airport-to-city table (the alternative this issue itself named as a fallback) and is left
for a future issue.

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


### Hostel data is weak in both stay providers, measured 2026-09-04

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
