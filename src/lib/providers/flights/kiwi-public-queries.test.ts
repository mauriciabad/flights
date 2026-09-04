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

	it('asks for direct flights only', () => {
		// The load-bearing filter. Kiwi's speciality is multi-carrier self-transfer
		// itineraries, and a domain FlightOffer cannot honestly represent one.
		expect(buildOneWayVariables(base).filter.maxStopsCount).toBe(0);
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

	it('asks for direct flights only, since that is what a route edge means', () => {
		expect(buildOnePerCityVariables(base).filter.maxStopsCount).toBe(0);
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
