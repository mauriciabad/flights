import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../cache';
import type { CacheStore, StoredCacheEntry } from '../cache';
import type { Duration, FlightOffer, Itinerary, LocalDateTime } from '../domain';
import type { ItineraryGroup, ItineraryResult } from '../search';
import { readLedgerMonths } from './observations';
import { ledgerSignature, legObservationsFromGroup, recordItineraryGroup } from './record-results';

function localDateTime(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function offer(overrides: Partial<FlightOffer> = {}): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber: 'FR1234',
		departureAirport: 'BCN',
		arrivalAirport: 'VIE',
		departure: localDateTime('2026-10-14T09:00:00'),
		arrival: localDateTime('2026-10-14T11:00:00'),
		duration: 120 as Duration,
		price: { minorUnits: 6000, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book',
		...overrides
	};
}

function variant(
	outboundFlight: FlightOffer,
	onwardFlight: FlightOffer,
	sources: { outbound: string; onward: string; fetchedAt: string }
): ItineraryResult {
	return {
		score: {
			itinerary: { outboundFlight, onwardFlight } as unknown as Itinerary,
			total: 0,
			breakdown: {} as never,
			avoidedAirlineFlightCount: 0
		},
		sources: {
			outboundFlight: { providerId: sources.outbound, fetchedAt: sources.fetchedAt },
			onwardFlight: { providerId: sources.onward, fetchedAt: sources.fetchedAt }
		}
	} as ItineraryResult;
}

function group(variants: ItineraryResult[]): ItineraryGroup {
	return { connectionAirportCode: 'VIE', best: variants[0], variants };
}

const FETCHED_AT = '2026-09-04T10:00:00.000Z';

describe('legObservationsFromGroup', () => {
	it('splits an itinerary into one observation per leg, with each leg its own route', () => {
		const observations = legObservationsFromGroup(
			group([
				variant(offer(), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP', price: { minorUnits: 4200, currency: 'EUR' } }), {
					outbound: 'ryanair',
					onward: 'kiwi-public',
					fetchedAt: FETCHED_AT
				})
			]),
			'EUR'
		);

		expect(observations).toHaveLength(2);
		expect(observations[0].leg).toEqual({ origin: 'BCN', destination: 'VIE', currency: 'EUR' });
		expect(observations[0].fares[0]).toMatchObject({
			departureDate: '2026-10-14',
			arrivalDate: '2026-10-14',
			minorUnits: 6000,
			providerId: 'ryanair',
			observedAt: Date.parse(FETCHED_AT)
		});
		expect(observations[1].leg).toEqual({ origin: 'VIE', destination: 'OTP', currency: 'EUR' });
		expect(observations[1].fares[0]).toMatchObject({ minorUnits: 4200, providerId: 'kiwi-public' });
	});

	// A party total divided by the traveller count is an average, not a fare. Ranking a week
	// on one would be exactly the invented number this whole feature exists to avoid.
	it('drops a party-total fare rather than dividing it by the traveller count', () => {
		const observations = legObservationsFromGroup(
			group([
				variant(offer({ priceScope: 'party-total' }), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }), {
					outbound: 'skyscanner',
					onward: 'ryanair',
					fetchedAt: FETCHED_AT
				})
			]),
			'EUR'
		);

		expect(observations.map((observation) => observation.leg.origin)).toEqual(['VIE']);
	});

	it('drops a fare quoted in another currency', () => {
		const observations = legObservationsFromGroup(
			group([
				variant(offer({ price: { minorUnits: 6000, currency: 'GBP' } }), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }), {
					outbound: 'ryanair',
					onward: 'ryanair',
					fetchedAt: FETCHED_AT
				})
			]),
			'EUR'
		);

		expect(observations.map((observation) => observation.leg.origin)).toEqual(['VIE']);
	});

	// The age printed next to a price has to be the age of the price, not of the read that
	// found it. Issue #151, from the other side.
	it('takes the observation time from the provider source, never from the clock', () => {
		const observations = legObservationsFromGroup(
			group([variant(offer(), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }), { outbound: 'ryanair', onward: 'ryanair', fetchedAt: '2026-09-01T08:00:00.000Z' })]),
			'EUR'
		);

		expect(observations[0].fares[0].observedAt).toBe(Date.parse('2026-09-01T08:00:00.000Z'));
	});

	it('collapses many variants on the same day into the cheapest one per source', () => {
		const observations = legObservationsFromGroup(
			group([
				variant(offer({ price: { minorUnits: 9000, currency: 'EUR' } }), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }), { outbound: 'ryanair', onward: 'ryanair', fetchedAt: FETCHED_AT }),
				variant(offer({ price: { minorUnits: 4000, currency: 'EUR' } }), offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }), { outbound: 'ryanair', onward: 'ryanair', fetchedAt: FETCHED_AT })
			]),
			'EUR'
		);

		const outbound = observations.find((observation) => observation.leg.origin === 'BCN');
		expect(outbound?.fares).toHaveLength(1);
		expect(outbound?.fares[0].minorUnits).toBe(4000);
	});

	it('keeps an overnight arrival on its own calendar date', () => {
		const observations = legObservationsFromGroup(
			group([
				variant(
					offer({
						departure: localDateTime('2026-10-14T22:55:00'),
						arrival: localDateTime('2026-10-15T00:20:00')
					}),
					offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' }),
					{ outbound: 'ryanair', onward: 'ryanair', fetchedAt: FETCHED_AT }
				)
			]),
			'EUR'
		);

		expect(observations[0].fares[0]).toMatchObject({
			departureDate: '2026-10-14',
			arrivalDate: '2026-10-15'
		});
	});
});

const onwardOffer = () => offer({ departureAirport: 'VIE', arrivalAirport: 'OTP' });
const ryanairPair = () =>
	group([
		variant(offer(), onwardOffer(), { outbound: 'ryanair', onward: 'ryanair', fetchedAt: FETCHED_AT })
	]);

describe('recordItineraryGroup', () => {
	it("writes a group's fares into the ledger", async () => {
		const store = new MemoryCacheStore();

		await recordItineraryGroup(ryanairPair(), 'EUR', { store });

		await expect(
			readLedgerMonths({ origin: 'BCN', destination: 'VIE', currency: 'EUR' }, ['2026-10-01'], {
				store,
				now: Date.parse(FETCHED_AT)
			})
		).resolves.toHaveLength(1);
	});

	// The pipeline re-yields a stopover's group every time anything about the search moves,
	// and every write is a read-modify-write against the store the search itself is reading
	// from.
	it('skips a group whose fares are already written', async () => {
		const store = new MemoryCacheStore();
		let writes = 0;
		const counting: CacheStore = {
			get: (key) => store.get(key),
			set: (entry: StoredCacheEntry) => {
				writes += 1;
				return store.set(entry);
			},
			deleteByProvider: (providerId) => store.deleteByProvider(providerId),
			clear: () => store.clear()
		};
		const alreadyWritten = new Set<string>();

		await recordItineraryGroup(ryanairPair(), 'EUR', { store: counting, alreadyWritten });
		const afterFirst = writes;
		await recordItineraryGroup(ryanairPair(), 'EUR', { store: counting, alreadyWritten });

		expect(afterFirst).toBeGreaterThan(0);
		expect(writes).toBe(afterFirst);
	});

	// The regression this dedupe key exists to avoid. A first attempt keyed on the group's
	// variant count and best total price, and a later yield that added a Kiwi fare without
	// changing either hashed the same as the Ryanair-only one before it. Measured live in a
	// browser: the warm view stopped saying "Priced by Kiwi.com and Ryanair".
	it('still writes a richer group whose variant count did not change', async () => {
		const store = new MemoryCacheStore();
		const alreadyWritten = new Set<string>();

		await recordItineraryGroup(ryanairPair(), 'EUR', { store, alreadyWritten });
		await recordItineraryGroup(
			group([
				variant(offer({ price: { minorUnits: 4000, currency: 'EUR' } }), onwardOffer(), {
					outbound: 'kiwi-public',
					onward: 'ryanair',
					fetchedAt: FETCHED_AT
				})
			]),
			'EUR',
			{ store, alreadyWritten }
		);

		const fares = await readLedgerMonths(
			{ origin: 'BCN', destination: 'VIE', currency: 'EUR' },
			['2026-10-01'],
			{ store, now: Date.parse(FETCHED_AT) }
		);
		expect(fares.map((fare) => fare.providerId).sort()).toEqual(['kiwi-public', 'ryanair']);
	});
});

describe('ledgerSignature', () => {
	it('is stable across leg order and changes when a fare does', () => {
		const a = legObservationsFromGroup(ryanairPair(), 'EUR');
		expect(ledgerSignature(a)).toBe(ledgerSignature([...a].reverse()));

		const b = legObservationsFromGroup(
			group([
				variant(offer({ price: { minorUnits: 1, currency: 'EUR' } }), onwardOffer(), {
					outbound: 'ryanair',
					onward: 'ryanair',
					fetchedAt: FETCHED_AT
				})
			]),
			'EUR'
		);
		expect(ledgerSignature(b)).not.toBe(ledgerSignature(a));
	});
});
