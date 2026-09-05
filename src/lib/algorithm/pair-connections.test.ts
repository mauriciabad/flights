/**
 * Issue #324: the refusals `pairConnections` reports, which is the half of the pairing loop
 * `buildItineraries` used to throw away.
 *
 * Every case here is a connection that produces no itinerary, and the assertion is on which
 * rule said no. Kept apart from `build.test.ts` because that file is about the trips this
 * module builds and this one is about the trips it declines to.
 */

import { describe, expect, it } from 'vitest';
import type { Airport, City, Country, Duration, FlightOffer, LocalDateTime } from '../domain';
import { pairConnections, type BuildItinerariesInput } from './build';

const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string): Airport {
	return {
		iataCode,
		name: `${iataCode} airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country,
		sizeClass: 'medium'
	};
}

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 60 };
}

function makeFlight(
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR1',
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		priceScope: 'per-person',
		duration: 90 as Duration,
		price: { minorUnits: 5000, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function baseInput(overrides: Partial<BuildItinerariesInput> = {}): BuildItinerariesInput {
	return {
		originAirport: makeAirport('LGW'),
		destinationAirport: makeAirport('IST'),
		outboundOffers: [],
		onwardOffers: [],
		connectionAirports: { VIE: makeAirport('VIE') },
		connectionResources: { VIE: {} },
		waitingTimeRules: [{ waitingTime: 0 as Duration }],
		minLayoverTime: 90 as Duration,
		...overrides
	};
}

describe('pairConnections', () => {
	it('reports a connection nothing arrives at, which no loop over offers would ever mention', () => {
		const { itineraries, blocked } = pairConnections(baseInput());

		expect(itineraries).toEqual([]);
		expect(blocked.VIE).toEqual({ reason: 'no-outbound-flight' });
	});

	it('separates "nothing flies onward" from "nothing flies here"', () => {
		const { blocked } = pairConnections(
			baseInput({ outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))] })
		);

		expect(blocked.VIE).toEqual({ reason: 'no-onward-flight' });
	});

	it('says the onward flight left before the inbound landed, and by how much', () => {
		const { blocked } = pairConnections(
			baseInput({
				outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))],
				onwardOffers: [makeFlight('VIE', 'IST', at('2027-03-08T09:20:00'), at('2027-03-08T11:00:00'))]
			})
		);

		expect(blocked.VIE).toEqual({
			reason: 'onward-before-arrival',
			closestLayover: -40,
			minLayoverTime: 90
		});
	});

	it('says the gap missed the traveller’s own minimum, with both numbers', () => {
		const { blocked } = pairConnections(
			baseInput({
				outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))],
				onwardOffers: [makeFlight('VIE', 'IST', at('2027-03-08T11:05:00'), at('2027-03-08T13:00:00'))]
			})
		);

		expect(blocked.VIE).toEqual({
			reason: 'layover-under-minimum',
			closestLayover: 65,
			minLayoverTime: 90
		});
	});

	it('keeps the closest miss when one connection is refused several ways', () => {
		// Three onward flights: one before the landing, one 20 minutes after, one 65 minutes
		// after. All are refused, and the last one is the fact worth telling the traveller.
		const { blocked } = pairConnections(
			baseInput({
				outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))],
				onwardOffers: [
					makeFlight('VIE', 'IST', at('2027-03-08T09:00:00'), at('2027-03-08T11:00:00')),
					makeFlight('VIE', 'IST', at('2027-03-08T10:20:00'), at('2027-03-08T12:00:00')),
					makeFlight('VIE', 'IST', at('2027-03-08T11:05:00'), at('2027-03-08T13:00:00'))
				]
			})
		);

		expect(blocked.VIE).toEqual({
			reason: 'layover-under-minimum',
			closestLayover: 65,
			minLayoverTime: 90
		});
	});

	it('separates a gap that clears the minimum but not the ground time it has to cover', () => {
		const { itineraries, blocked } = pairConnections(
			baseInput({
				minLayoverTime: 30 as Duration,
				waitingTimeRules: [{ waitingTime: 120 as Duration }],
				outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))],
				onwardOffers: [makeFlight('VIE', 'IST', at('2027-03-08T11:00:00'), at('2027-03-08T13:00:00'))]
			})
		);

		expect(itineraries).toEqual([]);
		expect(blocked.VIE).toEqual({
			reason: 'layover-under-ground-time',
			closestLayover: 60,
			groundTimeNeeded: 120
		});
	});

	it('leaves a connection that produced a trip out of the refusals entirely', () => {
		const { itineraries, blocked } = pairConnections(
			baseInput({
				outboundOffers: [
					makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00')),
					makeFlight('LGW', 'VIE', at('2027-03-08T18:00:00'), at('2027-03-08T20:00:00'))
				],
				// The second outbound leaves the traveller 90 minutes short of the onward
				// flight, so the loop refuses that pairing while the first one succeeds.
				onwardOffers: [makeFlight('VIE', 'IST', at('2027-03-08T20:30:00'), at('2027-03-08T22:00:00'))]
			})
		);

		expect(itineraries).toHaveLength(1);
		expect(blocked).toEqual({});
	});

	it('reports every considered connection, including ones no offer names', () => {
		const { blocked } = pairConnections(
			baseInput({
				connectionAirports: { VIE: makeAirport('VIE'), MXP: makeAirport('MXP') },
				connectionResources: { VIE: {}, MXP: {} },
				outboundOffers: [makeFlight('LGW', 'VIE', at('2027-03-08T08:00:00'), at('2027-03-08T10:00:00'))]
			})
		);

		expect(blocked).toEqual({
			VIE: { reason: 'no-onward-flight' },
			MXP: { reason: 'no-outbound-flight' }
		});
	});
});
