/**
 * The proof that #450's shape change cannot be undone by a cache entry written before it.
 *
 * AGENTS.md: "a cached value whose shape changed needs a key that no longer resolves to the
 * old one." That rule exists because #131 broke it. Real map geometry shipped on green CI,
 * the OSRM route cache kept its key, and everyone who had used the app that month installed
 * the fix and went on seeing straight lines for the next thirty days.
 *
 * A cached value is read back and used, never inspected and found wanting, so a test that
 * checks the new field is present on a fresh fetch proves nothing about the people who
 * already have the old one. These tests do the thing that actually goes wrong: they write
 * the value the old code would have written, under the key the old code would have written
 * it under, and then run the shipped adapter over it.
 *
 * The old keys are spelled out by hand here rather than derived, and that is the point. A
 * key built from the current code would move whenever the code moves and would agree with
 * itself for ever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore, defineCacheKey } from '../../cache';
import type { Stay } from '../../domain';
import { clearInFlightForTests, clearProviderQuotaStateForTests, resetPermanentFailuresForTests } from '../budget';
import { createAgodaStayProvider } from './agoda';
import { createBookingStayProvider } from './booking';
import { createHostelworldStayProvider } from './hostelworld';
import agodaGetPricesWombats from './fixtures/agoda-get-prices-wombats-hostel.json';
import agodaSearchVienna from './fixtures/agoda-search-vienna.json';
import bookingRoomListIbis from './fixtures/booking-room-list-ibis.json';
import bookingSearchVienna from './fixtures/booking-search-vienna.json';
import hostelworldContinentEurope from './fixtures/hostelworld-continent-europe.json';
import hostelworldPropertiesLondon from './fixtures/hostelworld-properties-london.json';
import nominatimVienna from './fixtures/nominatim-vienna.json';

const instantSleep = async () => {};

/** What one of these adapters cached before #450: a `Stay` with no `source` on it, and a
 * price nothing else in the fixtures quotes, so serving it is unmistakable. */
const STALE_PRICE_MINOR_UNITS = 111_111;

function staleStay(name: string): Stay {
	return {
		property: {
			name,
			coordinates: { latitude: 48.2, longitude: 16.37 },
			images: []
		},
		roomKind: 'private',
		pricePerNight: { minorUnits: STALE_PRICE_MINOR_UNITS, currency: 'EUR' }
	};
}

async function seed(store: MemoryCacheStore, providerId: string, query: unknown, value: unknown) {
	const key = defineCacheKey(providerId, query, 60 * 60_000);
	await store.set({
		key: key.raw,
		providerId,
		value,
		storedAt: Date.now(),
		ttlMs: key.ttlMs,
		lastAccessedAt: Date.now(),
		sizeBytes: 0
	});
	return key.raw;
}

const viennaQuery = {
	near: { latitude: 48.1103, longitude: 16.5697 },
	radiusKm: 25,
	checkIn: '2026-10-10',
	checkOut: '2026-10-12'
};

beforeEach(() => {
	clearInFlightForTests();
	clearProviderQuotaStateForTests();
	resetPermanentFailuresForTests();
	localStorage.clear();
});

describe('Booking, a Stay[] cached before #450 (issue #131, AGENTS.md)', () => {
	const bookingFetch = (async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.startsWith('https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotelsByCoordinates')) {
			return new Response(JSON.stringify(bookingSearchVienna), { status: 200 });
		}
		if (url.startsWith('https://booking-com15.p.rapidapi.com/api/v1/hotels/getRoomList')) {
			const hotelId = new URL(url).searchParams.get('hotel_id');
			const body = hotelId === '71662' ? bookingRoomListIbis : { data: { block: [] } };
			return new Response(JSON.stringify(body), { status: 200 });
		}
		throw new Error(`no stub for ${url}`);
	}) as typeof fetch;

	it('does not serve it, and the fresh answer carries the provider id', async () => {
		const store = new MemoryCacheStore();
		// Exactly the key `booking.ts` built before this change: no `stayShape`.
		const staleKey = await seed(
			store,
			'booking',
			{
				op: 'getRoomList',
				hotelId: 71662,
				checkIn: '2026-10-10',
				checkOut: '2026-10-12',
				travellers: 1,
				currency: undefined
			},
			[staleStay('Ibis Wien Hauptbahnhof')]
		);

		const provider = createBookingStayProvider({ store, fetchImpl: bookingFetch, sleep: instantSleep });
		const result = await provider.searchStays(viennaQuery, {
			signal: new AbortController().signal,
			keys: { apiKey: 'test-key' }
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((stay) => stay.pricePerNight.minorUnits)).not.toContain(
			STALE_PRICE_MINOR_UNITS
		);
		expect(result.data.length).toBeGreaterThan(0);
		expect(result.data.every((stay) => stay.source?.provider === 'booking')).toBe(true);
		expect(result.data.every((stay) => (stay.source?.propertyId.length ?? 0) > 0)).toBe(true);
		// The old entry is still sitting there, untouched. That is what makes the point: it
		// was not deleted or repaired, it simply stopped being reachable.
		expect(await store.get(staleKey)).toBeDefined();
	});
});

describe('Agoda, a Stay[] cached before #450', () => {
	const agodaFetch = (async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.startsWith('https://nominatim.openstreetmap.org/reverse')) {
			return new Response(JSON.stringify(nominatimVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search')) {
			return new Response(JSON.stringify(agodaSearchVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/get-prices')) {
			const propertyId = new URL(url).searchParams.get('property_id');
			const body =
				propertyId === '417108'
					? agodaGetPricesWombats
					: { data: { currencyInfo: { code: 'USD' }, roomGridData: { masterRooms: [] } } };
			return new Response(JSON.stringify(body), { status: 200 });
		}
		throw new Error(`no stub for ${url}`);
	}) as typeof fetch;

	it('does not serve it, and the fresh answer carries the provider id', async () => {
		const store = new MemoryCacheStore();
		const staleKey = await seed(
			store,
			'agoda',
			{
				op: 'getPrices',
				propertyId: 417108,
				checkIn: '2026-10-10',
				checkOut: '2026-10-12',
				travellers: 1,
				currencyId: undefined
			},
			[staleStay("Wombat's City Hostel Vienna")]
		);

		const provider = createAgodaStayProvider({ store, fetchImpl: agodaFetch, sleep: instantSleep });
		const result = await provider.searchStays(viennaQuery, {
			signal: new AbortController().signal,
			keys: { apiKey: 'test-key' }
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((stay) => stay.pricePerNight.minorUnits)).not.toContain(
			STALE_PRICE_MINOR_UNITS
		);
		expect(result.data.length).toBeGreaterThan(0);
		expect(result.data.every((stay) => stay.source?.provider === 'agoda')).toBe(true);
		expect(await store.get(staleKey)).toBeDefined();
	});
});

describe('Hostelworld, whose cache holds the provider body rather than a Stay', () => {
	const hostelworldFetch = (async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.includes('/continents/')) {
			return new Response(JSON.stringify(hostelworldContinentEurope), { status: 200 });
		}
		if (url.includes('/properties/')) {
			return new Response(JSON.stringify(hostelworldPropertiesLondon), { status: 200 });
		}
		throw new Error(`no stub for ${url}`);
	}) as typeof fetch;

	/**
	 * The other half of the claim, and the reason this adapter's key is deliberately NOT
	 * versioned. It caches the response body Hostelworld sent and runs `mapPropertiesToStays`
	 * on every read, so a property id that was in the body all along becomes a `Stay.source`
	 * with no eviction and no request. Versioning it would spend one request per city to
	 * relearn something already on disk.
	 */
	it('fills the new field straight out of an entry written before #450', async () => {
		const store = new MemoryCacheStore();
		const warm = createHostelworldStayProvider({ store, fetchImpl: hostelworldFetch });
		const near = { latitude: 51.5074, longitude: -0.1278 };
		const query = { near, radiusKm: 40, checkIn: '2026-10-09', checkOut: '2026-10-12' };
		const first = await warm.searchStays(query, { signal: new AbortController().signal });
		expect(first.ok).toBe(true);

		// Nothing may reach the network on the second pass. If the entry did not resolve, this
		// throws rather than quietly refetching and passing for the wrong reason.
		const refuseFetch = (async () => {
			throw new Error('the cached body should have answered this');
		}) as typeof fetch;
		const cold = createHostelworldStayProvider({ store, fetchImpl: refuseFetch });
		const second = await cold.searchStays(query, { signal: new AbortController().signal });

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.length).toBeGreaterThan(0);
		expect(second.data.every((stay) => stay.source?.provider === 'hostelworld')).toBe(true);
	});
});
