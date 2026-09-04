import { describe, expect, it } from 'vitest';
import {
	ONE_PER_CITY_DIRECT_QUERY,
	ONE_WAY_DIRECT_QUERY,
	buildOnePerCityVariables,
	buildOneWayVariables,
	stationId
} from './kiwi-public-queries';

describe('stationId', () => {
	it('addresses an airport by its IATA code, so no autocomplete lookup is needed', () => {
		expect(stationId('lgw')).toBe('Station:airport:LGW');
	});
});

describe('buildOneWayVariables', () => {
	const base = {
		origin: 'BVC',
		destination: 'LGW',
		earliestDeparture: '2026-10-06',
		latestDeparture: '2026-10-08',
		currency: 'EUR',
		limit: 50
	};

	it('covers the whole departure window in one request', () => {
		const variables = buildOneWayVariables(base);

		expect(variables.search.itinerary.outboundDepartureDate).toEqual({
			start: '2026-10-06T00:00:00',
			end: '2026-10-08T23:59:59'
		});
	});

	it('asks for one flight, which is not the same as asking for a nonstop', () => {
		// Issue #210. `maxStopsCount: 0` used to be the whole filter, and it silently
		// excluded a real product: Kiwi counts a technical stop as a stop, so BVC->FCO
		// returned nothing at 0 and returned Neos NO4864 at 1. The other two entries pay
		// for the widening by keeping genuine connections off the wire; the mapper, not
		// this, is what decides which of what comes back is really one flight.
		expect(buildOneWayVariables(base).filter).toMatchObject({
			maxStopsCount: 1,
			enableSelfTransfer: false,
			stopoverTime: { start: 0, end: 2 }
		});
	});

	it('always prices exactly one adult, so priceScope is true by construction', () => {
		// Issue #109: an unverified 'party-total' triples a group quote and an unverified
		// 'per-person' undercounts it. Sending one adult removes the question.
		expect(buildOneWayVariables(base).search.passengers.adults).toBe(1);
	});

	it('lowercases the currency, which is what the API accepts', () => {
		expect(buildOneWayVariables(base).options.currency).toBe('eur');
	});

	it('does not store the search against a Kiwi session', () => {
		expect(buildOneWayVariables(base).options.storeSearch).toBe(false);
	});

	it('names both airports as Kiwi station ids', () => {
		const variables = buildOneWayVariables(base);
		expect(variables.search.itinerary.source.ids).toEqual(['Station:airport:BVC']);
		expect(variables.search.itinerary.destination.ids).toEqual(['Station:airport:LGW']);
	});
});

describe('buildOnePerCityVariables', () => {
	const base = {
		origin: 'BVC',
		earliestDeparture: '2026-10-01',
		latestDeparture: '2026-10-31',
		currency: 'EUR',
		limit: 100
	};

	it('leaves the destination unfiltered', () => {
		expect(buildOnePerCityVariables(base).search.itinerary.destination.ids).toEqual(['anywhere']);
	});

	it('asks for one flight, since that is what a route edge means', () => {
		// Same widening as the fare query, and issue #210's route depends on it: Rome is
		// one flight from Boa Vista, so it belongs in this list, and it was missing from it
		// only because that flight touches down in Sal on the way.
		expect(buildOnePerCityVariables(base).filter).toMatchObject({
			maxStopsCount: 1,
			enableSelfTransfer: false,
			stopoverTime: { start: 0, end: 2 }
		});
	});
});

describe('query documents', () => {
	it('handle the AppError branch of both unions', () => {
		// Kiwi resolves a union: an unhandled AppError branch would silently read as an
		// empty result, hiding the provider's own message that AGENTS.md requires showing.
		expect(ONE_WAY_DIRECT_QUERY).toContain('... on AppError { error: message }');
		expect(ONE_PER_CITY_DIRECT_QUERY).toContain('... on AppError { error: message }');
	});

	it('ask for the IANA time zone on both ends of a segment', () => {
		// This is what lets the adapter skip a Transitous round trip per airport.
		const zoneMentions = ONE_WAY_DIRECT_QUERY.match(/timezone/g) ?? [];
		expect(zoneMentions).toHaveLength(2);
	});

	it('ask for the station type, so non-airport codes can be filtered out', () => {
		expect(ONE_PER_CITY_DIRECT_QUERY).toContain('station { code type }');
	});
});
