import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, LocalDateTime } from '../domain';
import {
	departureDateOf,
	departureDates,
	flightKey,
	flightOn,
	isSameFlight,
	pairingUsing,
	pairingsOn,
	resolveStopover,
	type PairingTrip,
	type PairingView
} from './pairings';

/** Barcelona in September, which is the owner's own origin on the search this issue came
 * from, so the fixtures read like the trip he was looking at. */
function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 };
}

function flight(flightNumber: string, departure: string, arrival: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber,
		departureAirport: 'BCN',
		arrivalAirport: 'OPO',
		departure: at(departure),
		arrival: at(arrival),
		duration: 120 as Duration,
		price: { minorUnits: 4000, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

/** A pairing, in exactly the fields the module reads plus a label and a price so a failing
 * assertion names the trip rather than printing an object. */
interface Pairing extends PairingTrip {
	label: string;
	cost: number;
}

const view: PairingView<Pairing> = { tripOf: (pairing) => pairing, costOf: (pairing) => pairing.cost };

function pairing(
	label: string,
	options: { out: FlightOffer; onward: FlightOffer; nights: number; cost: number }
): Pairing {
	return {
		label,
		cost: options.cost,
		nightsInConnection: options.nights,
		outboundFlight: options.out,
		onwardFlight: options.onward
	};
}

const OUT_16 = flight('FR100', '2026-09-16T06:20:00', '2026-09-16T08:25:00');
const OUT_17_MORNING = flight('FR102', '2026-09-17T07:10:00', '2026-09-17T09:15:00');
const OUT_17_EVENING = flight('FR104', '2026-09-17T20:25:00', '2026-09-17T22:30:00');
const OUT_18 = flight('FR106', '2026-09-18T11:30:00', '2026-09-18T13:35:00');
const ONWARD_17 = flight('FR200', '2026-09-17T10:00:00', '2026-09-17T15:00:00');
const ONWARD_18 = flight('FR202', '2026-09-18T10:00:00', '2026-09-18T15:00:00');
const ONWARD_20 = flight('FR204', '2026-09-20T10:00:00', '2026-09-20T15:00:00');

describe('flightKey and isSameFlight', () => {
	it('separates the same flight number on two days', () => {
		const monday = flight('FR58', '2026-09-16T06:20:00', '2026-09-16T08:25:00');
		const tuesday = flight('FR58', '2026-09-17T06:20:00', '2026-09-17T08:25:00');

		expect(flightKey(monday)).not.toBe(flightKey(tuesday));
		expect(isSameFlight(monday, tuesday)).toBe(false);
	});

	it('matches two copies of one flight that are not the same object', () => {
		// The case that matters in the app: Svelte deep-proxies `$state`, so one offer read
		// through two paths arrives as two objects with equal contents.
		expect(isSameFlight(OUT_16, { ...OUT_16 })).toBe(true);
	});
});

describe('departureDateOf', () => {
	it('reads the origin airport’s own calendar date', () => {
		expect(departureDateOf(pairing('a', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 100 }))).toBe(
			'2026-09-16'
		);
	});

	it('keeps a late-evening departure on the day the departure board says', () => {
		// 8:25pm in Madrid is 6:25pm UTC, and an implementation that normalised to UTC would
		// still get this one right. The one that matters is the reverse direction, so the
		// assertion is that nothing converts at all: the string is read, not recomputed.
		expect(
			departureDateOf(pairing('b', { out: OUT_17_EVENING, onward: ONWARD_18, nights: 1, cost: 100 }))
		).toBe('2026-09-17');
	});
});

describe('flightOn', () => {
	it('names the leg rather than the position', () => {
		const trip = pairing('a', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 100 });
		expect(flightOn(trip, 'outbound')).toBe(OUT_16);
		expect(flightOn(trip, 'onward')).toBe(ONWARD_17);
	});
});

describe('resolveStopover', () => {
	const candidates = [
		pairing('one-night', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 24880 }),
		pairing('two-night', { out: OUT_16, onward: ONWARD_18, nights: 2, cost: 26000 }),
		pairing('four-night', { out: OUT_16, onward: ONWARD_20, nights: 4, cost: 21000 })
	];

	it('opens on the cheapest length, not the shortest', () => {
		// Issue #364's rule, reached through the extracted resolver rather than a second copy
		// of it: the app never spends the traveller's money to make a choice that is theirs.
		expect(resolveStopover(candidates, view).chosen?.pick.label).toBe('four-night');
	});

	it('honours a length the traveller asked for', () => {
		expect(resolveStopover(candidates, view, 2).chosen?.pick.label).toBe('two-night');
	});

	it('falls to the cheapest rather than the nearest when the length is not on offer', () => {
		expect(resolveStopover(candidates, view, 3).chosen?.pick.label).toBe('four-night');
	});

	it('resolves to nothing for an empty set', () => {
		const resolved = resolveStopover([], view, 1);
		expect(resolved.chosen).toBeUndefined();
		expect(resolved.minimum).toBeUndefined();
		expect(resolved.lengths).toEqual([]);
	});
});

describe('departureDates', () => {
	const candidates = [
		pairing('16th, 1 night', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 24880 }),
		pairing('16th, 2 nights', { out: OUT_16, onward: ONWARD_18, nights: 2, cost: 31000 }),
		pairing('17th morning, 1 night', { out: OUT_17_MORNING, onward: ONWARD_18, nights: 1, cost: 29900 }),
		pairing('17th evening, 3 nights', { out: OUT_17_EVENING, onward: ONWARD_20, nights: 3, cost: 27400 }),
		pairing('18th, 2 nights', { out: OUT_18, onward: ONWARD_20, nights: 2, cost: 33200 })
	];

	it('offers every date the stopover leaves on, in calendar order', () => {
		expect(departureDates(candidates, view).map((rung) => rung.date)).toEqual([
			'2026-09-16',
			'2026-09-17',
			'2026-09-18'
		]);
	});

	it('takes the cheapest trip on each date', () => {
		// The 17th has a EUR 299 morning trip and a EUR 274 evening one, and the evening one
		// is the answer to "what is the best combination for flying on the 17".
		const rungs = departureDates(candidates, view);
		expect(rungs.map((rung) => rung.pick.label)).toEqual([
			'16th, 1 night',
			'17th evening, 3 nights',
			'18th, 2 nights'
		]);
	});

	it('counts every pairing on a date, not only the one it offers', () => {
		expect(departureDates(candidates, view).map((rung) => rung.count)).toEqual([2, 2, 1]);
	});

	it('keeps the length the traveller pinned when the date can do it', () => {
		// A traveller who asked for two nights and then asks about the 16th should be shown
		// the 16th's two-night trip, not its cheapest, or the date ladder would quietly undo
		// the nights ladder.
		const rungs = departureDates(candidates, view, 2);
		expect(rungs[0]?.pick.label).toBe('16th, 2 nights');
	});

	it('falls to a date’s own cheapest when it cannot do the pinned length', () => {
		// The 17th has no two-night pairing. Offering its cheapest is the same answer the card
		// gives someone who has asked for nothing, and the pin stays recorded so moving back
		// to the 16th gets two nights again.
		const rungs = departureDates(candidates, view, 2);
		expect(rungs[1]?.pick.label).toBe('17th evening, 3 nights');
	});

	it('is empty for no candidates', () => {
		expect(departureDates([], view)).toEqual([]);
	});
});

describe('pairingsOn', () => {
	it('keeps only the pairings that leave on the date', () => {
		const candidates = [
			pairing('16th', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 100 }),
			pairing('17th', { out: OUT_17_MORNING, onward: ONWARD_18, nights: 1, cost: 100 })
		];

		expect(pairingsOn(candidates, view, '2026-09-17').map((p) => p.label)).toEqual(['17th']);
		expect(pairingsOn(candidates, view, '2026-09-19')).toEqual([]);
	});
});

describe('pairingUsing', () => {
	// The 17th evening outbound lands at 10:30pm, so the onward flight the trip is currently
	// on (10am on the 17th) has already gone. This is the case that produces "The onward
	// flight leaves before this one lands, so there is no connection to make."
	const candidates = [
		pairing('16th, 1 night', { out: OUT_16, onward: ONWARD_17, nights: 1, cost: 24880 }),
		pairing('17th evening, 1 night', { out: OUT_17_EVENING, onward: ONWARD_18, nights: 1, cost: 31500 }),
		pairing('17th evening, 3 nights', { out: OUT_17_EVENING, onward: ONWARD_20, nights: 3, cost: 27400 })
	];

	it('answers with a trip that connects, for an outbound whose old onward has gone', () => {
		const found = pairingUsing(candidates, view, 'outbound', OUT_17_EVENING);

		expect(found?.label).toBe('17th evening, 3 nights');
		expect(found?.onwardFlight).toBe(ONWARD_20);
	});

	it('keeps the pinned length when the flight can do it', () => {
		expect(pairingUsing(candidates, view, 'outbound', OUT_17_EVENING, 1)?.label).toBe(
			'17th evening, 1 night'
		);
	});

	it('works the same way from the onward leg', () => {
		expect(pairingUsing(candidates, view, 'onward', ONWARD_17)?.outboundFlight).toBe(OUT_16);
	});

	it('answers with nothing for a flight no pairing flies', () => {
		// The caller is then holding the flight the traveller picked and the warning that
		// describes it, which is the case the warning exists for.
		expect(pairingUsing(candidates, view, 'outbound', OUT_18)).toBeUndefined();
	});

	it('matches a flight by identity rather than by reference', () => {
		expect(pairingUsing(candidates, view, 'outbound', { ...OUT_16 })?.label).toBe('16th, 1 night');
	});
});
