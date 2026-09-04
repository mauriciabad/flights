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

| API | Free quota | Rate limit |
|---|---|---|
| Sky Scrapper | **20 requests / month**, hard limit | 1000/hour |
| Flights Sky | **50 requests / month**, hard limit | 1000/hour |

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

**OurAirports** publishes a 12 MB public-domain CSV of every airport. Filter it at build
time. Never ship it to a phone.

## Travelpayouts

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
