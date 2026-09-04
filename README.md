# Layover

Find flights to places with no direct route, by turning the connection into a trip.

Live at **[flights.mauri.app](https://flights.mauri.app)**

## The idea

Flying somewhere with no direct route usually means a miserable four-hour layover. But
if you are going to change planes anyway, a stopover of three days often costs less than
the direct flight, and you get a second city out of it. Regular flight search cannot plan
this, because it will not price the hotel, and it will not tell you whether a bus runs
from the airport at the hour your first flight lands.

This does. One search returns whole itineraries: both flights, a bed in the connection
city, every transfer between them, and the actual timetable for each leg.

## How it works

Static site. No backend, no server, nothing to deploy but files. Every API call goes
straight from your browser to the provider, using **your own API keys**, stored in
`localStorage` and exportable as JSON so you can move them between devices.

Verified before the design was chosen: every provider below returns
`Access-Control-Allow-Origin` for browser origins, which is what makes the no-backend
rule possible.

### Providers

| Kind | Provider | Key |
|---|---|---|
| Flights | Skyscanner (via RapidAPI) | yours |
| Flights | Ryanair | none needed |
| Transport | Rome2Rio (via RapidAPI) | yours |
| Transport | Transitous / MOTIS, real timetables | none needed |
| Transport | OSRM, walking and driving | none needed |
| Hotels | Agoda, Booking (via RapidAPI) | yours |
| Hotels | OpenStreetMap, inventory only | none needed |
| Airports | OurAirports | none needed |

The keyless providers mean the app does something useful before you enter any key. They
also act as a check on the paid ones: Ryanair fares come straight from the airline, so
if Skyscanner disagrees about a Ryanair flight, the app can say so instead of trusting
one source.

## Development

```bash
pnpm install
pnpm dev
```

`pnpm check` type-checks, `pnpm build` produces the static site in `build/`.

## Project docs

- [docs/prompts/](docs/prompts/) — every instruction from the owner, word for word
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — provider research, CORS results, what died

## Licence

MIT
