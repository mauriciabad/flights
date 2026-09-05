import { describe, expect, it } from 'vitest';
import type { Airport, City, Country, Duration } from '../domain';
import { describeBlock, describeUnpriced, pointLabel, spokenSummary, summariseConnections } from './copy';
import type { ConnectionOnMap } from './model';

const country: Country = { isoCode: 'AT', name: 'Austria' };
const coordinates = { latitude: 48.11, longitude: 16.57 };
// `City.coordinates` is optional (only cities with a hand-checked centre point have one),
// so the airport takes the literal rather than reading it back off the city.
const city: City = { name: 'Vienna', coordinates, country };
const VIE: Airport = {
	iataCode: 'VIE',
	name: 'Vienna airport',
	coordinates,
	city,
	country,
	sizeClass: 'large'
};

/** Only the fields the copy reads. The arcs and the trip are irrelevant to a sentence. */
function connection(overrides: Partial<ConnectionOnMap>): ConnectionOnMap {
	return {
		airport: VIE,
		arcs: [[], []],
		extraKm: 0,
		rank: 1,
		state: 'pending',
		...overrides
	} as ConnectionOnMap;
}

describe('describeBlock', () => {
	it('separates the three refusals a traveller can act on differently', () => {
		expect(describeBlock({ reason: 'no-onward-flight' }).headline).toBe('Nothing flies onward');
		expect(describeBlock({ reason: 'no-outbound-flight' }).headline).toBe('Nothing flies here');
		expect(
			describeBlock({ reason: 'onward-before-arrival', closestLayover: -40 as Duration, minLayoverTime: 90 as Duration })
				.headline
		).toBe('The onward flight goes first');
	});

	it('states the gap as a positive length when the onward flight leaves first', () => {
		// "-40m before you land" is not a sentence. The sign is carried by the words.
		const copy = describeBlock({
			reason: 'onward-before-arrival',
			closestLayover: -40 as Duration,
			minLayoverTime: 90 as Duration
		});

		expect(copy.detail).toBe('The nearest onward flight leaves 40m before you land.');
	});

	it('prints the measurement and the traveller’s own rule side by side', () => {
		const copy = describeBlock({
			reason: 'layover-under-minimum',
			closestLayover: 65 as Duration,
			minLayoverTime: 90 as Duration
		});

		expect(copy.detail).toBe('The longest gap here is 1h 5m, and your minimum layover is 1h 30m.');
	});

	it('says what the ground time is spent on when a legal layover still leaves none', () => {
		const copy = describeBlock({
			reason: 'layover-under-ground-time',
			closestLayover: 60 as Duration,
			groundTimeNeeded: 120 as Duration
		});

		expect(copy.detail).toBe(
			'The longest gap here is 1h, and getting into town, back, and checked in takes 2h.'
		);
	});

	it('says the app does not know the place rather than that nothing flies there', () => {
		// Different claims. One is about aviation and one is about this app's dataset.
		expect(describeBlock({ reason: 'airport-unknown' }).detail).toContain('no record of where this airport is');
	});
});

describe('describeUnpriced', () => {
	it('says nothing when every part was quoted', () => {
		expect(describeUnpriced({ bed: false, transferLegs: [] })).toBeUndefined();
	});

	it('names the bed on its own', () => {
		expect(describeUnpriced({ bed: true, transferLegs: [] })).toBe(
			'Nobody priced a bed for the night, so this total is a floor.'
		);
	});

	it('names every unpriced part in one sentence', () => {
		expect(describeUnpriced({ bed: true, transferLegs: ['transferToHotel', 'transferToConnectionAirport'] })).toBe(
			'Nobody priced a bed for the night, the ride into town and the ride back to the airport, so this total is a floor.'
		);
	});

	it('calls the total a floor rather than a price, every time', () => {
		expect(describeUnpriced({ bed: false, transferLegs: ['transferToOriginAirport'] })).toContain('a floor');
	});
});

describe('summariseConnections', () => {
	it('counts the states apart instead of reporting one total', () => {
		expect(summariseConnections({ bookable: 2, 'part-priced': 1, blocked: 4, pending: 0 })).toBe(
			'7 connection airports considered: 3 with a trip and 4 without one.'
		);
	});

	it('leaves out a state nothing is in', () => {
		expect(summariseConnections({ bookable: 1, 'part-priced': 0, blocked: 0, pending: 0 })).toBe(
			'1 connection airport considered: 1 with a trip.'
		);
	});

	it('names the ones still being looked at rather than folding them into the failures', () => {
		expect(summariseConnections({ bookable: 0, 'part-priced': 0, blocked: 1, pending: 2 })).toBe(
			'3 connection airports considered: 1 without one and 2 still being looked at.'
		);
	});

	it('says nothing has been considered rather than "0 airports"', () => {
		expect(summariseConnections({ bookable: 0, 'part-priced': 0, blocked: 0, pending: 0 })).toBe(
			'No connection airports considered yet.'
		);
	});
});

describe('pointLabel', () => {
	it('gives a refused point the reason, not just the city', () => {
		expect(pointLabel(connection({ state: 'blocked', block: { reason: 'no-onward-flight' } }))).toBe(
			'Vienna (VIE): Nothing flies onward'
		);
	});

	it('keeps "still looking" apart from "nothing flies"', () => {
		expect(pointLabel(connection({ state: 'pending' }))).toBe('Vienna (VIE): still being looked at');
	});

	it('carries the price when there is one, and only the place when there is not', () => {
		const priced = connection({ state: 'bookable' });
		expect(pointLabel(priced, '€238.00')).toBe('Vienna (VIE): €238.00');
		expect(pointLabel(priced)).toBe('Vienna (VIE)');
	});
});

describe('spokenSummary', () => {
	it('reads a refusal as its measurement, since the headline alone says nothing new', () => {
		expect(
			spokenSummary(
				connection({
					state: 'blocked',
					block: { reason: 'layover-under-minimum', closestLayover: 65 as Duration, minLayoverTime: 90 as Duration }
				}),
				{}
			)
		).toBe('Vienna, VIE. The longest gap here is 1h 5m, and your minimum layover is 1h 30m.');
	});

	it('reads a trip as the two or three numbers, not the whole panel', () => {
		expect(spokenSummary(connection({ state: 'bookable' }), { price: '€238.00', flightTime: '3h 35m', nights: 2 })).toBe(
			'Vienna, VIE. €238.00 in total, 3h 35m in the air and 2 nights.'
		);
	});

	it('says one night rather than 1 nights', () => {
		expect(spokenSummary(connection({ state: 'bookable' }), { nights: 1 })).toBe('Vienna, VIE. 1 night.');
	});
});
