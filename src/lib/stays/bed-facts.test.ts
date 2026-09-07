import { describe, expect, it } from 'vitest';
import type { Coordinates, Itinerary, Stay, Transfer } from '$lib/domain';
import { bedFacts, reachFromTransfer, reachModeOf } from './bed-facts';
import { stayReachPoints } from './reach';

const VIENNA_AIRPORT: Coordinates = { latitude: 48.1103, longitude: 16.5697 };

function stay(overrides: Partial<Stay> = {}): Stay {
	return {
		property: {
			name: 'Wombats City Hostel',
			coordinates: { latitude: 48.2015, longitude: 16.3776 },
			images: []
		},
		roomKind: 'dorm',
		pricePerNight: { minorUnits: 3900, currency: 'EUR' },
		...overrides
	} as Stay;
}

function trip(overrides: Partial<Itinerary> = {}): Itinerary {
	return { nightsInConnection: 2, travellers: 1, stay: stay(), ...overrides } as Itinerary;
}

describe('bedFacts', () => {
	it('has nothing to say about a trip with no bed on it', () => {
		expect(bedFacts(trip({ stay: undefined }), VIENNA_AIRPORT)).toBeUndefined();
	});

	it('carries the room kind in the picker tiles own words', () => {
		expect(bedFacts(trip(), VIENNA_AIRPORT)?.roomKindLabel).toBe('Dorm bed');
	});

	it('quotes the rate bedNightlyRate decided, audience and all', () => {
		// Issue #206: two travellers on a room nobody quoted per head reads as the party's
		// figure with the party named, never as a division of it.
		const facts = bedFacts(trip({ travellers: 3 }), VIENNA_AIRPORT);
		expect(facts?.rate).toEqual({ money: { minorUnits: 3900, currency: 'EUR' }, audience: 'for 3' });
	});

	it('leaves the distance out when the caller resolved no airport position', () => {
		expect(bedFacts(trip())?.distanceFromAirportKm).toBeUndefined();
	});

	it('measures the straight line to the airport when it has a position', () => {
		const km = bedFacts(trip(), VIENNA_AIRPORT)?.distanceFromAirportKm;
		// Wombats to Schwechat is about 16 km as the crow flies. The assertion is a band, not
		// a digit: what matters is that this is the airport-to-property line and not zero.
		expect(km).toBeGreaterThan(13);
		expect(km).toBeLessThan(19);
	});
});

describe('reachFromTransfer', () => {
	it('has nothing to state for a trip with no ride to the bed', () => {
		expect(reachFromTransfer(undefined)).toBeUndefined();
	});

	it('states the ride under its own mode, and asks nothing of the others', () => {
		const bus = { mode: 'transit', duration: 34 } as Transfer;
		const reach = reachFromTransfer(bus);
		expect(reach?.transit).toEqual({ kind: 'routed', minutes: 34 });
		expect(reach?.walk).toEqual({ kind: 'not-asked' });
		expect(reach?.taxi).toEqual({ kind: 'not-asked' });
		expect(stayReachPoints(reach)).toEqual([{ mode: 'transit', time: '34m', word: 'Public transport' }]);
	});

	it('quotes the ride, not the walk out of the terminal in front of it', () => {
		// Issue #290 made `duration` landing to doorstep. The row says how long the journey
		// takes, and the buffer belongs to the airport rather than to the property.
		const taxi = { mode: 'taxi', duration: 40, landingBuffer: 18 } as Transfer;
		expect(reachFromTransfer(taxi)?.taxi).toEqual({ kind: 'routed', minutes: 22 });
	});

	it('draws a driven leg as the taxi a traveller who just landed would take', () => {
		const driven = { mode: 'drive', duration: 25 } as Transfer;
		expect(reachFromTransfer(driven)?.taxi).toEqual({ kind: 'routed', minutes: 25 });
	});
});

describe('reachModeOf', () => {
	it('maps every transfer mode onto a mode the reach row can draw', () => {
		expect(reachModeOf('walk')).toBe('walk');
		expect(reachModeOf('transit')).toBe('transit');
		expect(reachModeOf('taxi')).toBe('taxi');
		expect(reachModeOf('drive')).toBe('taxi');
	});
});
