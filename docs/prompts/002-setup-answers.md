# Prompt 002 — Setup answers, and a rejected proposal

- **Date:** 2026-09-04
- **Author:** Maurici Abad Gutierrez (@mauriciabad)
- **Channel:** Answers to the agent's opening setup questions

## Context

The agent had found that Amadeus Self-Service, its intended flight and hotel source, was
shut down: `api.amadeus.com` and `test.api.amadeus.com` no longer resolve in DNS. It
proposed falling back to a keyless stack (Ryanair, Transitous, OSRM, OpenStreetMap) with
an optional Cloudflare Worker holding shared API keys.

Maurici rejected that proposal. His answer is the source of the whole BYOK design.

## Verbatim — on data providers

```text
NO! your proposal is UNACEPTABLE! This app must be usefull and use the same tools or very similar than the ones i use in realiti. This means Skyscanner is non negotiable. as well asrome to rio or google maps or womething that has good public transport support. and also agoda or hostel world or even maybe somethign related to booking or another hotel searcher. Travelpayouts seems like a good option but you must make sure it gives the cheapest results, in my experience skyscanner has always the cheapest price and agoda as well. No need for cloudflare, user can enter his own keys in the ui and they get saved on the localstorage, maybe he can even import and export a json file with all of them for convinience share, i dont want a backend.
```

## Verbatim — on recording prompts

```text
simply keep the prompt. and there wont be just 1 prompt, i may tell you more things that also need recording wherever they belong too. for example in these answers i'm also giving you new info that should be saved
```

## Verbatim — on autonomy and the repo

Selected from multiple choice, so these are the agent's words that Maurici picked:

```text
Autonomy: "Full send" — swarm agents open PRs against issues, CI gates them, green PRs
auto-merge to main, Pages redeploys. Review the result in the morning.

Repo: mauriciabad/flights, public.
```

## Requirements this creates

Binding, in the user's priority order.

1. **Skyscanner is non-negotiable.** Not "a flight API". Skyscanner specifically, or
   something that returns the same prices. Reached through RapidAPI, since Skyscanner's
   own partner API is not self-serve.
2. **Real public transport.** Rome2Rio, Google Maps, or an equivalent with genuinely good
   transit coverage. Not a straight-line estimate, not driving time with a fudge factor.
3. **Real hotel prices.** Agoda, Hostelworld, Booking, or a comparable searcher.
4. **Prove the price is the cheapest.** Travelpayouts is acceptable only if it is shown to
   match or beat the others. "In my experience Skyscanner has always the cheapest price
   and Agoda as well" is a claim the app has to test, not assume. This is why a
   cross-provider price check exists rather than a single hardcoded source.
5. **No backend. None.** No Cloudflare Worker, no proxy, no server of any kind. The user
   enters their own keys in the UI, they persist to localStorage, and they can be exported
   and imported as a JSON file to move between devices or share.

## Why the no-backend rule is satisfiable

Verified by probing the APIs directly on 2026-09-04, before writing any code:

| Endpoint | Preflight | `Access-Control-Allow-Origin` |
|---|---|---|
| `sky-scrapper.p.rapidapi.com` | 200 | reflects `https://flights.mauri.app` |
| `booking-com15.p.rapidapi.com` | 200 | reflects `https://flights.mauri.app` |
| `rome2rio.p.rapidapi.com` | 200 | reflects `https://flights.mauri.app` |
| `api.transitous.org` | 200 | `*` |
| `services-api.ryanair.com` | 200 | `*` |
| `router.project-osrm.org` | 200 | `*` |

RapidAPI reflects the request `Origin` and allows `x-rapidapi-key` in
`Access-Control-Allow-Headers`, so the browser can call every one of these directly. A
proxy would have added nothing except a server to run.

## Derived decisions

Agent's calls, not the user's words.

- Keyless providers stay in as a baseline so the app does something useful before any key
  is entered, and as an independent check on requirement 4. Ryanair fares come straight
  from the airline, so when Skyscanner disagrees with Ryanair on a Ryanair flight, one of
  them is wrong and the app should say so.
- Keys never leave the browser. No telemetry, no error reporter that could capture them,
  and the export file is generated client-side.
