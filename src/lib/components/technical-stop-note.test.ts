import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, TechnicalStop } from '../domain';
import { technicalStopDetail, technicalStopLabel } from './technical-stop-note';

function localTime(local: string): TechnicalStop['arrival'] {
	return { local, timeZone: 'Atlantic/Cape_Verde', utcOffsetMinutes: -60 };
}

/** The real Neos NO4864 offer this feature exists for, trimmed to what these two functions
 * read. See providers/flights/fixtures/kiwi-public-oneway-bvc-fco.json for the response it
 * comes from. */
function neosOffer(technicalStops?: TechnicalStop[]): FlightOffer {
	return {
		carrier: { iataCode: 'NO', name: 'Neos Air' },
		flightNumber: 'NO4864',
		departureAirport: 'BVC',
		arrivalAirport: 'FCO',
		departure: localTime('2026-10-08T13:40:00'),
		arrival: localTime('2026-10-08T23:50:00'),
		duration: 430 as Duration,
		price: { minorUnits: 26200, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://www.kiwi.com/en/search/results/BVC/FCO/2026-10-08',
		...(technicalStops ? { technicalStops } : {})
	};
}

const salStop: TechnicalStop = {
	airport: 'SID',
	arrival: localTime('2026-10-08T14:10:00'),
	departure: localTime('2026-10-08T15:10:00'),
	groundTime: 60 as Duration
};

describe('technicalStopLabel', () => {
	it('makes the claim issue #210 asked for, and no larger one', () => {
		// "1 stop" alone would read as a connection; "no plane change" alone would read as
		// a nonstop. The sentence is only honest with both halves.
		expect(technicalStopLabel(neosOffer([salStop]))).toBe('1 stop, no plane change');
	});

	it('pluralises without inventing a second sentence', () => {
		const second: TechnicalStop = { ...salStop, airport: 'LPA' };
		expect(technicalStopLabel(neosOffer([salStop, second]))).toBe('2 stops, no plane change');
	});

	it('says nothing about a nonstop flight', () => {
		expect(technicalStopLabel(neosOffer())).toBeUndefined();
	});

	it('says nothing when the list is present but empty', () => {
		// Every mapper in this codebase omits the field instead, but a consumer reading a
		// cached offer written by an older build should still get silence, not "0 stops".
		expect(technicalStopLabel(neosOffer([]))).toBeUndefined();
	});
});

describe('technicalStopDetail', () => {
	it('names the airport and how long the aircraft sits there', () => {
		expect(technicalStopDetail(neosOffer([salStop]))).toBe(
			'Stops in SID for 1h, everyone stays on board.'
		);
	});

	it('joins two stops without a comma before the last one', () => {
		const second: TechnicalStop = { ...salStop, airport: 'LPA', groundTime: 45 as Duration };
		expect(technicalStopDetail(neosOffer([salStop, second]))).toBe(
			'Stops in SID for 1h and LPA for 45m, everyone stays on board.'
		);
	});

	it('says nothing about a nonstop flight', () => {
		expect(technicalStopDetail(neosOffer())).toBeUndefined();
	});
});
