import { describe, expect, it } from 'vitest';
import type { FlightOffer, Itinerary, LocalDateTime, Transfer } from '../domain';
import {
	EMPTY_ALTERNATIVES,
	TRANSFER_LEGS,
	optionMarksFor,
	stayChoiceIsRelevant,
	withheldTransfersByLeg,
	type AlternativesPool
} from './option-marks';

function at(local: string): LocalDateTime {
	return { local, utcOffsetMinutes: 120 } as LocalDateTime;
}

function flight(flightNumber: string, departureLocal: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber,
		departureAirport: 'BCN',
		arrivalAirport: 'VIE',
		departure: at(departureLocal),
		arrival: at('2027-03-08T10:15:00'),
		duration: 135,
		price: { minorUnits: 1499, currency: 'EUR' },
		priceScope: 'per-person'
	} as FlightOffer;
}

const RIDE = { mode: 'taxi', duration: 22 } as Transfer;

function trip(overrides: Partial<Itinerary> = {}): Itinerary {
	return { nightsInConnection: 2, ...overrides } as Itinerary;
}

function pool(overrides: Partial<AlternativesPool> = {}): AlternativesPool {
	return { ...EMPTY_ALTERNATIVES, ...overrides };
}

describe('optionMarksFor', () => {
	it('marks a leg only once the picker would draw a second row', () => {
		const one = flight('FR846', '2027-03-08T08:00:00');
		expect(optionMarksFor(trip(), pool({ outboundFlights: [one] }))['outbound-flight']).toBeUndefined();
		// The same departure sold twice is one row, which is `flightKey`'s whole job. A mark
		// counting the raw array would promise a choice the panel renders as "Current pick".
		expect(
			optionMarksFor(trip(), pool({ outboundFlights: [one, one] }))['outbound-flight']
		).toBeUndefined();
		expect(
			optionMarksFor(
				trip(),
				pool({ outboundFlights: [one, flight('FR848', '2027-03-08T14:20:00')] })
			)['outbound-flight']
		).toBe('2 flights');
	});

	it('names the onward leg separately from the outbound one', () => {
		const marks = optionMarksFor(
			trip(),
			pool({
				onwardFlights: [
					flight('FR100', '2027-03-10T09:00:00'),
					flight('FR200', '2027-03-10T18:00:00'),
					flight('FR300', '2027-03-10T21:00:00')
				]
			})
		);
		expect(marks['onward-flight']).toBe('3 flights');
		expect(marks['outbound-flight']).toBeUndefined();
	});

	it('says nothing about a transfer leg the itinerary does not have', () => {
		// The count belongs to the search; the leg belongs to the trip. A candidate list for
		// a leg this itinerary never took would open a panel about a ride nobody is taking.
		const marks = optionMarksFor(
			trip(),
			pool({ transferCandidateCounts: { transferToHotel: 4 } })
		);
		expect(marks['transfer-to-hotel']).toBeUndefined();
	});

	it('marks a transfer leg the itinerary has, once there is more than one candidate', () => {
		const withRide = trip({ transferToHotel: RIDE });
		expect(
			optionMarksFor(withRide, pool({ transferCandidateCounts: { transferToHotel: 1 } }))[
				'transfer-to-hotel'
			]
		).toBeUndefined();
		expect(
			optionMarksFor(withRide, pool({ transferCandidateCounts: { transferToHotel: 4 } }))[
				'transfer-to-hotel'
			]
		).toBe('4 options');
	});

	it('counts a stay list from one property, and pluralises it', () => {
		// One property is still a choice: price the bed in, or leave it out. That is the rule
		// `hasSwappableAlternatives` held and the one the stay panel renders under.
		expect(optionMarksFor(trip(), pool({ stayPropertyCount: 1 }))['free-time']).toBe('1 stay');
		expect(optionMarksFor(trip(), pool({ stayPropertyCount: 6 }))['free-time']).toBe('6 stays');
	});

	it('promises no bed on a stopover with no night to sleep through', () => {
		const sameDay = trip({ nightsInConnection: 0 });
		expect(optionMarksFor(sameDay, pool({ stayPropertyCount: 6 }))['free-time']).toBeUndefined();
	});

	it('keeps the mark on a nightless stopover that already has a bed on it', () => {
		const pinned = trip({ nightsInConnection: 0, stay: {} as Itinerary['stay'] });
		expect(optionMarksFor(pinned, pool({ stayPropertyCount: 6 }))['free-time']).toBe('6 stays');
	});

	it('marks nothing at all for a search that came back with one of everything', () => {
		expect(optionMarksFor(trip(), EMPTY_ALTERNATIVES)).toEqual({});
	});
});

describe('withheldTransfersByLeg', () => {
	it('files the destination leg under the name the timeline looks it up by', () => {
		// The bug this table exists to make unrepresentable: the refusal was written under
		// 'to-destination', `UnroutedLeg` calls it 'to-destination-location', and the row read
		// "no route came back" about a route that came back and was declined.
		const refused = { road: { longest: 33 * 60 } } as never;
		expect(withheldTransfersByLeg(pool({ transferWithheld: { transferToDestinationLocation: refused } }))).toEqual(
			{ 'to-destination-location': refused }
		);
	});

	it('files the ride back to the airport under from-hotel', () => {
		const refused = { walk: { longest: 73 } } as never;
		expect(withheldTransfersByLeg(pool({ transferWithheld: { transferToConnectionAirport: refused } }))).toEqual({
			'from-hotel': refused
		});
	});

	it('holds no key for a leg nobody refused anything on', () => {
		expect(withheldTransfersByLeg(EMPTY_ALTERNATIVES)).toEqual({});
	});
});

describe('TRANSFER_LEGS', () => {
	it('names each leg once in each of the three vocabularies', () => {
		expect(TRANSFER_LEGS).toHaveLength(4);
		expect(new Set(TRANSFER_LEGS.map((leg) => leg.field)).size).toBe(4);
		expect(new Set(TRANSFER_LEGS.map((leg) => leg.segment)).size).toBe(4);
		expect(new Set(TRANSFER_LEGS.map((leg) => leg.leg)).size).toBe(4);
	});
});

describe('stayChoiceIsRelevant', () => {
	it('is false only for a stopover with neither a night nor a bed', () => {
		expect(stayChoiceIsRelevant(trip({ nightsInConnection: 0 }))).toBe(false);
		expect(stayChoiceIsRelevant(trip({ nightsInConnection: 1 }))).toBe(true);
		expect(
			stayChoiceIsRelevant(trip({ nightsInConnection: 0, stay: {} as Itinerary['stay'] }))
		).toBe(true);
	});
});
