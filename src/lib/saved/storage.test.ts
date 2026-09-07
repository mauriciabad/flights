import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeQuery } from '$lib/search-history/storage';
import {
	appendObservation,
	clearSavedItineraries,
	forgetItinerary,
	isRepeatVisit,
	loadSavedItineraries,
	MAX_PRICE_OBSERVATIONS,
	MAX_SAVED_ITINERARIES,
	recordPrice,
	saveItinerary,
	savedItineraryId,
	writeSavedItineraries
} from './storage';
import { makeObservation, makeSaved, makeTrip, money } from './test-support';

const STORAGE_KEY = 'flights.savedItineraries.v1';

describe('savedItineraryId', () => {
	it('is the same string for the same search written in a different order', () => {
		const a = normalizeQuery(new URLSearchParams('from=BCN&to=OTP&dep=2026-10-01'));
		const b = normalizeQuery(new URLSearchParams('dep=2026-10-01&to=OTP&from=BCN'));
		expect(savedItineraryId(a, 'VIE')).toBe(savedItineraryId(b, 'VIE'));
	});

	it('tells two stopovers of one search apart', () => {
		expect(savedItineraryId('from=BCN', 'VIE')).not.toBe(savedItineraryId('from=BCN', 'BER'));
	});

	it('tells two searches through one stopover apart', () => {
		expect(savedItineraryId('from=BCN', 'VIE')).not.toBe(savedItineraryId('from=MAD', 'VIE'));
	});

	it('cannot be collided by moving the separator into the query', () => {
		// `@` percent-encodes inside a query string and an IATA code is three letters, so no
		// pair of inputs can produce another pair's id. A collision would merge two trips'
		// price logs.
		const query = normalizeQuery(new URLSearchParams({ note: 'BER@from=X' }));
		expect(savedItineraryId(query, 'VIE')).not.toBe(savedItineraryId('from=X', 'BER'));
	});
});

describe('saveItinerary', () => {
	it('puts a new trip at the top', () => {
		const entries = saveItinerary([makeSaved({ id: 'a', savedAt: 1 })], makeSaved({ id: 'b', savedAt: 2 }));
		expect(entries.map((entry) => entry.id)).toEqual(['b', 'a']);
	});

	it('leaves a trip that is already saved exactly as it was', () => {
		const kept = makeSaved({ id: 'a', savedAt: 1, prices: [makeObservation({ visit: 'v1' })] });
		const entries = saveItinerary([kept], makeSaved({ id: 'a', savedAt: 500, prices: [] }));
		expect(entries).toEqual([kept]);
	});

	it('drops the oldest save once the list is full', () => {
		let entries = [makeSaved({ id: 'oldest', savedAt: 0 })];
		for (let i = 1; i <= MAX_SAVED_ITINERARIES; i += 1) {
			entries = saveItinerary(entries, makeSaved({ id: `t${i}`, savedAt: i }));
		}
		expect(entries).toHaveLength(MAX_SAVED_ITINERARIES);
		expect(entries.some((entry) => entry.id === 'oldest')).toBe(false);
	});
});

describe('forgetItinerary', () => {
	it('takes out exactly the one asked for', () => {
		const entries = forgetItinerary([makeSaved({ id: 'a' }), makeSaved({ id: 'b' })], 'a');
		expect(entries.map((entry) => entry.id)).toEqual(['b']);
	});
});

describe('the visit-token refusal', () => {
	const first = makeObservation({ visit: 'visit-1', observedAt: 10 });

	it('appends an observation from a new visit', () => {
		const next = makeObservation({ visit: 'visit-2', observedAt: 20 });
		expect(appendObservation([first], next)).toEqual([first, next]);
	});

	it('refuses a second observation from the visit already on top', () => {
		const rerender = makeObservation({ visit: 'visit-1', observedAt: 11, total: money(999) });
		expect(appendObservation([first], rerender)).toEqual([first]);
	});

	it('says so as a predicate, which is what the store reads before it prices anything', () => {
		expect(isRepeatVisit([first], 'visit-1')).toBe(true);
		expect(isRepeatVisit([first], 'visit-2')).toBe(false);
		expect(isRepeatVisit([], 'visit-1')).toBe(false);
	});

	it('accepts a token again once another visit has been logged over it', () => {
		const other = makeObservation({ visit: 'visit-2', observedAt: 20 });
		const again = makeObservation({ visit: 'visit-1', observedAt: 30 });
		expect(appendObservation([first, other], again)).toHaveLength(3);
	});

	it('drops the oldest price once the log is full', () => {
		let prices = [makeObservation({ visit: 'oldest', observedAt: 0 })];
		for (let i = 1; i <= MAX_PRICE_OBSERVATIONS; i += 1) {
			prices = appendObservation(prices, makeObservation({ visit: `v${i}`, observedAt: i }));
		}
		expect(prices).toHaveLength(MAX_PRICE_OBSERVATIONS);
		expect(prices[0].visit).toBe('v1');
		expect(prices.at(-1)?.visit).toBe(`v${MAX_PRICE_OBSERVATIONS}`);
	});
});

describe('recordPrice', () => {
	it('grows the log of the trip named and leaves the others alone', () => {
		const entries = [makeSaved({ id: 'a' }), makeSaved({ id: 'b' })];
		const next = recordPrice(entries, 'a', makeObservation({ visit: 'v2', observedAt: 2000 }));
		expect(next[0].prices).toHaveLength(2);
		expect(next[1].prices).toHaveLength(1);
	});

	it('records nothing for a trip nobody saved', () => {
		const entries = [makeSaved({ id: 'a' })];
		expect(recordPrice(entries, 'nope', makeObservation({ visit: 'v2' }))).toEqual(entries);
	});
});

describe('localStorage round trip', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('reads back what it wrote, newest save first', () => {
		writeSavedItineraries([makeSaved({ id: 'a', savedAt: 1 }), makeSaved({ id: 'b', savedAt: 2 })]);
		expect(loadSavedItineraries().map((entry) => entry.id)).toEqual(['b', 'a']);
	});

	it('reads nothing saved when nothing was ever saved', () => {
		expect(loadSavedItineraries()).toEqual([]);
	});

	it('reads nothing saved rather than throwing on corrupt data', () => {
		localStorage.setItem(STORAGE_KEY, '{not json');
		expect(loadSavedItineraries()).toEqual([]);
	});

	it('reads nothing saved when the file is not a list', () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'a' }));
		expect(loadSavedItineraries()).toEqual([]);
	});

	it('drops entries of the wrong shape and keeps the rest', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([makeSaved({ id: 'a' }), { id: 'b' }, null, 7, { id: 'c', query: '', savedAt: 1 }])
		);
		expect(loadSavedItineraries().map((entry) => entry.id)).toEqual(['a']);
	});

	it('drops a trip whose flights no longer parse, since a row cannot be drawn without them', () => {
		const broken = makeSaved({ id: 'broken' });
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([{ ...broken, trip: { ...broken.trip, onwardFlight: { flightNumber: 'W6200' } } }])
		);
		expect(loadSavedItineraries()).toEqual([]);
	});

	it('keeps a trip whose bed no longer parses, because the flights still draw a row', () => {
		const entry = makeSaved({ id: 'a' });
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([{ ...entry, trip: { ...entry.trip, bed: { roomKind: 'suite' } } }])
		);
		const [loaded] = loadSavedItineraries();
		expect(loaded.trip.bed).toBeUndefined();
		expect(loaded.trip.outboundFlight.flightNumber).toBe('VY100');
	});

	it('drops a ground leg naming a mode this app has no icon or word for', () => {
		const entry = makeSaved({
			id: 'a',
			trip: makeTrip({ groundLegs: [{ leg: 'transferToHotel', mode: 'transit' }] })
		});
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				{
					...entry,
					trip: {
						...entry.trip,
						groundLegs: [...entry.trip.groundLegs, { leg: 'transferToHotel', mode: 'hovercraft' }]
					}
				}
			])
		);
		expect(loadSavedItineraries()[0].trip.groundLegs).toEqual([
			{ leg: 'transferToHotel', mode: 'transit' }
		]);
	});

	it('keeps a price row whose parts are gone but whose total is readable', () => {
		const entry = makeSaved({ id: 'a', prices: [makeObservation()] });
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				{ ...entry, prices: [{ ...entry.prices[0], flights: { minorUnits: 'lots', currency: 'EUR' } }] }
			])
		);
		const [row] = loadSavedItineraries()[0].prices;
		// Absent, not zero: a part nobody can read is a part nobody priced, which is the same
		// claim the stored shape makes everywhere else.
		expect(row.flights).toBeUndefined();
		expect(row.total).toEqual(money(18_200));
	});

	it('drops a price row with no readable total at all', () => {
		const entry = makeSaved({ id: 'a', prices: [makeObservation()] });
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([{ ...entry, prices: [{ ...entry.prices[0], total: null }] }])
		);
		expect(loadSavedItineraries()[0].prices).toEqual([]);
	});

	it('never hands back more trips than the cap, even if the stored file is longer', () => {
		const stored = Array.from({ length: MAX_SAVED_ITINERARIES + 5 }, (_, i) =>
			makeSaved({ id: `t${i}`, savedAt: i })
		);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		expect(loadSavedItineraries()).toHaveLength(MAX_SAVED_ITINERARIES);
	});

	it('never hands back a longer price log than the cap, and keeps the newest end of it', () => {
		const prices = Array.from({ length: MAX_PRICE_OBSERVATIONS + 5 }, (_, i) =>
			makeObservation({ visit: `v${i}`, observedAt: i })
		);
		localStorage.setItem(STORAGE_KEY, JSON.stringify([makeSaved({ id: 'a', prices })]));
		const loaded = loadSavedItineraries()[0].prices;
		expect(loaded).toHaveLength(MAX_PRICE_OBSERVATIONS);
		expect(loaded.at(-1)?.visit).toBe(`v${MAX_PRICE_OBSERVATIONS + 4}`);
	});

	it('puts a price log back in order when the stored file is not', () => {
		const prices = [
			makeObservation({ visit: 'late', observedAt: 900 }),
			makeObservation({ visit: 'early', observedAt: 100 })
		];
		localStorage.setItem(STORAGE_KEY, JSON.stringify([makeSaved({ id: 'a', prices })]));
		expect(loadSavedItineraries()[0].prices.map((price) => price.visit)).toEqual(['early', 'late']);
	});

	it('forgets everything on clear', () => {
		writeSavedItineraries([makeSaved()]);
		clearSavedItineraries();
		expect(loadSavedItineraries()).toEqual([]);
	});
});
