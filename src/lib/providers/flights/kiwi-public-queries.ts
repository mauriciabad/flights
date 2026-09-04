/**
 * The two GraphQL documents this adapter sends, and the pure functions that build their
 * variables. No I/O here, so kiwi-public-queries.test.ts can assert the exact request
 * body without a network stub.
 *
 * Both documents were written against the live schema by introspecting it on 2026-09-04
 * (`__schema { queryType { fields { name } } }` still answers from a browser origin), not
 * copied from documentation — Kiwi publishes none for this endpoint. The field selections
 * are deliberately minimal: `ItineraryOneWay` alone exposes 30 fields, and asking for
 * things this app cannot use would make an undocumented dependency more fragile than it
 * has to be, for no gain.
 */

import type { IsoCalendarDate, IsoCurrencyCode } from '../../domain';

/**
 * `?featureName=` on the URL. Kiwi's own site sends one and it shows up in their logs, so
 * sending a truthful name rather than impersonating a site query is both politer and
 * easier for them to rate-limit or block deliberately if they ever want to.
 */
export const ONE_WAY_FEATURE_NAME = 'SearchOneWayItinerariesQuery';
export const ONE_PER_CITY_FEATURE_NAME = 'OnePerCityItinerariesQuery';

/**
 * Direct flights only, priced, between two airports across a date range — ONE request for
 * the whole range, unlike Sky Scrapper's one-request-per-day shape (docs/PROVIDERS.md).
 *
 * `SINGLE_FLIGHT_FILTER` is the load-bearing part. Kiwi's speciality is multi-carrier
 * self-transfer itineraries (its answer for BVC→PFO chains easyJet, Ryanair and Jet2
 * through two different cities), but a domain `FlightOffer` is exactly one flight with one
 * carrier and one flight number, and this app builds the connection itself so it can put a
 * night in the middle. Asking for connections here and flattening them would either
 * fabricate a single "offer" that no airline sells, or silently reprice a three-leg journey
 * as one leg. Neither is acceptable, so this asks only for what maps honestly.
 *
 * `followingTechnicalStop` is the one field added for issue #210. See
 * `kiwi-public-types.ts` for what it means and how that was established.
 */
export const ONE_WAY_DIRECT_QUERY = `query SearchOneWayItinerariesQuery($search: SearchOnewayInput, $filter: ItinerariesFilterInput, $options: ItinerariesOptionsInput) {
  onewayItineraries(search: $search, filter: $filter, options: $options) {
    __typename
    ... on AppError { error: message }
    ... on Itineraries {
      itineraries {
        __typename
        ... on ItineraryOneWay {
          id
          price { amount currency { code } }
          bagsInfo { includedCheckedBags includedHandBags }
          sector {
            sectorSegments {
              segment {
                code
                duration
                followingTechnicalStop
                carrier { code name }
                source { localTime station { code timezone } }
                destination { localTime station { code timezone } }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Every airport reachable from one origin on a SINGLE FLIGHT — nonstop, or with a technical
 * stop the traveller sits through — one result per destination city, in a single request.
 * (It said "direct" before issue #210, and the widened `SINGLE_FLIGHT_FILTER` below is what
 * changed. Sal is why: Rome is one flight from Boa Vista and was missing from this list.)
 * This is the capability no other adapter in this codebase has:
 * Sky Scrapper's `searchFlightEverywhere` is deprecated and its v2 replacement only answers
 * at country level, and Flights Sky has no equivalent endpoint at all — both of their
 * `listDirectDestinations` implementations return a failure saying so. Ryanair answers it,
 * but only for Ryanair's own network, which is why an origin like Boa Vista produced zero
 * connection candidates and therefore zero itineraries no matter which keys were configured.
 */
export const ONE_PER_CITY_DIRECT_QUERY = `query OnePerCityItinerariesQuery($search: SearchOnewayInput, $filter: ItinerariesFilterInput, $options: ItinerariesOptionsInput) {
  onewayOnePerCityItineraries(search: $search, filter: $filter, options: $options) {
    __typename
    ... on AppError { error: message }
    ... on OnePerCityItineraries {
      itineraries { destination { station { code type } } }
    }
  }
}`;

/** How Kiwi addresses an airport. `Station:airport:LGW` resolves straight from an IATA
 * code, so this adapter never needs the `places` autocomplete query that Kiwi's own site
 * uses to turn typed text into an id — the app already knows the code. */
export function stationId(iataCode: string): string {
	return `Station:airport:${iataCode.toUpperCase()}`;
}

/** The magic destination that means "no destination filter". Confirmed live: passing it
 * to `onewayOnePerCityItineraries` for BVC returned 12 real destination airports. */
const ANYWHERE = 'anywhere';

/**
 * Exactly one adult, always, regardless of how many people the search is really for.
 *
 * That is a deliberate reading of issue #109's rule rather than an oversight. `FlightOffer`
 * requires every adapter to declare whether its price is one person's fare or the whole
 * party's, and getting it wrong is worse than not asking: Sky Scrapper's `adults` parameter
 * returns a party total, so multiplying it again roughly triples a group's quote, while
 * assuming a party total that is really per-person undercounts it. Whether Kiwi's price
 * scales with `passengers.adults` was not measured, so this adapter removes the question
 * instead of guessing at the answer — it prices one adult, reports `'per-person'`, and lets
 * the itinerary builder multiply. True by construction, the same shape flights-sky.ts
 * arrived at.
 */
const ONE_ADULT = {
	adults: 1,
	children: 0,
	infants: 0,
	adultsHoldBags: [0],
	adultsHandBags: [0],
	childrenHoldBags: [],
	childrenHandBags: []
} as const;

const ECONOMY = { cabinClass: 'ECONOMY', applyMixedClasses: false } as const;

/**
 * Longest ground time, in hours, this adapter will ask Kiwi to consider for a stop.
 *
 * Purely a request-narrowing number. It never decides what a technical stop IS — only
 * `kiwi-public-mapper.ts` does that, from `followingTechnicalStop` and the flight number —
 * so getting it slightly wrong costs recall or requests, never correctness. Two hours is
 * comfortably above real refuelling and pick-up stops (the Neos SID stop this was built for
 * is exactly one hour) and well below any connection a person would call a layover.
 */
const TECHNICAL_STOP_MAX_HOURS = 2;

/**
 * Ask for what fits in one `FlightOffer`: one flight, one flight number, boarded once.
 *
 * `maxStopsCount: 0` used to be the whole of this, and it is what issue #210 was about.
 * Kiwi counts a technical stop as a stop, so `0` silently excluded a real product: measured
 * 2026-09-04, BVC→FCO for 6-8 October 2026 returns ZERO itineraries at `maxStopsCount: 0`
 * and exactly one at `1` — Neos NO4864, BVC 13:40 → SID 14:10, SID 15:10 → FCO 23:50, one
 * aircraft, one flight number, EUR 262. The owner's read is that this may be the lowest
 * door-to-door option on his own route, so "widen the request and let the mapper judge" is
 * the only shape that can find it. Fixing the mapper alone would have changed nothing,
 * because the response never contained the itinerary in the first place.
 *
 * The other two entries pay for that widening, and both were measured rather than assumed:
 *
 * - `enableSelfTransfer: false` drops Kiwi's own stitched-together multi-carrier
 *   itineraries. It is NOT a plane-change filter and must not be mistaken for one — with it
 *   set, BVC→LGW still offered TAP 1568 then TAP 1334 via Lisbon on one booking, two flight
 *   numbers, twelve hours apart. The mapper rejects that; this only keeps it off the wire.
 * - `stopoverTime` bounds the ground time. Together the two keep the widening cheap:
 *   Boa Vista's direct-destination list goes from 11 airports to 20 rather than to the 60+
 *   an unfiltered one-stop search returns, and BVC→FCO comes back with the one Neos
 *   itinerary instead of twenty-one mostly-unusable ones.
 *
 * Direct flights are untouched by any of it, which was checked rather than reasoned about:
 * BVC→LGW and LGW→PFO, the two legs docs/ACCEPTANCE.md's reference route is made of,
 * return byte-identical itinerary sets before and after (4 and 22 respectively).
 */
const SINGLE_FLIGHT_FILTER = {
	maxStopsCount: 1,
	enableSelfTransfer: false,
	stopoverTime: { start: 0, end: TECHNICAL_STOP_MAX_HOURS }
} as const;

function optionsFor(currency: IsoCurrencyCode) {
	return {
		sortBy: 'PRICE',
		// Lowercase: the API echoes back an uppercase ISO code on `price.currency.code`,
		// but rejects an uppercase one here.
		currency: currency.toLowerCase(),
		locale: 'en',
		partner: 'skypicker',
		affilID: 'skypicker',
		// This app has no Kiwi session and no reason to leave one behind. Search history is
		// the user's own business and there is no backend here to own it (AGENTS.md rule 2).
		storeSearch: false,
		searchStrategy: 'REDUCED'
	};
}

/** Kiwi wants a wall-clock range, not a bare date, and treats both bounds as inclusive.
 * The whole departure-date window the caller asked for goes in one request. */
function departureWindow(earliest: IsoCalendarDate, latest: IsoCalendarDate) {
	return { start: `${earliest}T00:00:00`, end: `${latest}T23:59:59` };
}

export interface OneWayVariablesInput {
	origin: string;
	destination: string;
	earliestDeparture: IsoCalendarDate;
	latestDeparture: IsoCalendarDate;
	currency: IsoCurrencyCode;
	/** Caps how many itineraries come back. Not a request-budget knob (this is one request
	 * either way) — it bounds the response size, which matters on a phone. */
	limit: number;
}

export function buildOneWayVariables(input: OneWayVariablesInput) {
	return {
		search: {
			itinerary: {
				source: { ids: [stationId(input.origin)] },
				destination: { ids: [stationId(input.destination)] },
				outboundDepartureDate: departureWindow(input.earliestDeparture, input.latestDeparture)
			},
			passengers: ONE_ADULT,
			cabinClass: ECONOMY
		},
		filter: {
			transportTypes: ['FLIGHT'],
			// KIWI only. The other providers Kiwi's own site can mix in (FRESH, KAYAK) return
			// itineraries this adapter has no way to price-check or deep-link honestly.
			contentProviders: ['KIWI'],
			...SINGLE_FLIGHT_FILTER,
			limit: input.limit,
			flightsApiLimit: input.limit
		},
		options: optionsFor(input.currency)
	};
}

export interface OnePerCityVariablesInput {
	origin: string;
	earliestDeparture: IsoCalendarDate;
	latestDeparture: IsoCalendarDate;
	currency: IsoCurrencyCode;
	limit: number;
}

export function buildOnePerCityVariables(input: OnePerCityVariablesInput) {
	return {
		search: {
			itinerary: {
				source: { ids: [stationId(input.origin)] },
				destination: { ids: [ANYWHERE] },
				outboundDepartureDate: departureWindow(input.earliestDeparture, input.latestDeparture)
			},
			passengers: ONE_ADULT,
			cabinClass: ECONOMY
		},
		filter: {
			transportTypes: ['FLIGHT'],
			contentProviders: ['KIWI'],
			// Same widening as the fare query, and it is what makes issue #210's route
			// findable at all: `connections.ts` can only propose a stopover this ever
			// listed, and Rome is absent from Boa Vista's direct-destination list precisely
			// because the only flight there has a technical stop in Sal.
			...SINGLE_FLIGHT_FILTER,
			limit: input.limit,
			flightsApiLimit: input.limit
		},
		options: optionsFor(input.currency)
	};
}
