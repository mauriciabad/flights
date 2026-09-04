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
 * `maxStopsCount: 0` is the load-bearing filter. Kiwi's speciality is multi-carrier
 * self-transfer itineraries (its answer for BVC→PFO chains easyJet, Ryanair and Jet2
 * through two different cities), but a domain `FlightOffer` is exactly one flight with one
 * carrier and one flight number, and this app builds the connection itself so it can put a
 * night in the middle. Asking for connections here and flattening them would either
 * fabricate a single "offer" that no airline sells, or silently reprice a three-leg journey
 * as one leg. Neither is acceptable, so this asks only for what maps honestly.
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
 * Every airport reachable on a DIRECT flight from one origin, one result per destination
 * city, in a single request. This is the capability no other adapter in this codebase has:
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
			maxStopsCount: 0,
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
			maxStopsCount: 0,
			limit: input.limit,
			flightsApiLimit: input.limit
		},
		options: optionsFor(input.currency)
	};
}
