/**
 * What asking one provider about one property's rooms costs, and what it refuses to ask.
 *
 * Issue #449's whole design is a request budget: thirty of these was measured at 30 requests
 * and up to 7 seconds, one at 6.4 KB and under half a second. So the assertions that matter
 * here are counts, not contents. The mapping itself is covered in
 * `providers/stays/hostelworld-mapper.test.ts`, which needs no fetch at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '$lib/cache';
import type { Stay } from '$lib/domain';
import availabilityRooms from '$lib/providers/stays/fixtures/hostelworld-property-availability-rooms.json';
import { roomPhotoQueryFor, roomPhotosAvailableFrom, stayRoomPhotos } from './fetch-room-photos';

const query = { checkIn: '2026-10-07', nights: 3, guests: 1, currency: 'EUR' };

function stayAt(provider: 'hostelworld' | 'booking' | 'agoda', roomId?: string): Stay {
	return {
		property: {
			name: 'Rest Up London',
			coordinates: { latitude: 51.49, longitude: -0.09 },
			images: []
		},
		roomKind: 'dorm',
		pricePerNight: { minorUnits: 1907, currency: 'EUR' },
		source: { provider, propertyId: '312244', ...(roomId ? { roomId } : {}) }
	};
}

let urls: string[] = [];

function fixtureFetch(status = 200, body: unknown = availabilityRooms): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		urls.push(input.toString());
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

async function drain(stay: Stay, store: MemoryCacheStore, fetchImpl: typeof fetch) {
	const answers = [];
	for await (const answer of stayRoomPhotos(stay, query, { signal: new AbortController().signal }, { store, fetchImpl })) {
		answers.push(answer);
	}
	return answers;
}

beforeEach(() => {
	urls = [];
});

describe('stayRoomPhotos', () => {
	it('spends exactly one request for one property, and puts its dates in the URL', async () => {
		const answers = await drain(stayAt('hostelworld'), new MemoryCacheStore(), fixtureFetch());
		expect(urls).toHaveLength(1);
		expect(urls[0]).toBe(
			'https://api.m.hostelworld.com/2.2/properties/312244/availability/' +
				'?currency=EUR&date-start=2026-10-07&num-nights=3&guests=1'
		);
		expect(answers).toHaveLength(1);
		expect(answers[0].state).toBe('fresh');
		expect(answers[0].photos.byKind.dorm).toHaveLength(3);
	});

	it('answers a second look out of the cache first, then goes and checks anyway', async () => {
		// AGENTS.md, "stale first, then fresh". The held answer paints at once and the network
		// answer replaces it in place, which is why this yields twice rather than once.
		const store = new MemoryCacheStore();
		await drain(stayAt('hostelworld'), store, fixtureFetch());
		const second = await drain(stayAt('hostelworld'), store, fixtureFetch());
		expect(second.map((answer) => answer.state)).toEqual(['stale', 'fresh']);
		expect(second[0].photos.byRoomId['851743']).toHaveLength(4);
	});

	it('asks nothing at all of a provider that publishes no room photographs', async () => {
		// Booking's room block and Agoda's master room carry none (docs/PROVIDERS.md), and both
		// cost the owner real money. A request here would spend his quota to learn nothing.
		for (const provider of ['booking', 'agoda'] as const) {
			const answers = await drain(stayAt(provider), new MemoryCacheStore(), fixtureFetch());
			expect(answers).toEqual([]);
		}
		expect(urls).toEqual([]);
		expect(roomPhotosAvailableFrom('hostelworld')).toBe(true);
		expect(roomPhotosAvailableFrom('booking')).toBe(false);
		expect(roomPhotosAvailableFrom('agoda')).toBe(false);
	});

	it('asks nothing for a stay carrying no provider identity', async () => {
		const anonymous: Stay = { ...stayAt('hostelworld'), source: undefined };
		expect(await drain(anonymous, new MemoryCacheStore(), fixtureFetch())).toEqual([]);
		expect(urls).toEqual([]);
	});

	it('rejects with the provider own words when there is nothing held', async () => {
		// AGENTS.md: show the error you got, never the one you assumed. The status and the
		// body both survive to the caller.
		const store = new MemoryCacheStore();
		const failing = fixtureFetch(400, {
			description: [{ code: '2021', message: 'date-start is missing or invalid' }]
		});
		await expect(drain(stayAt('hostelworld'), store, failing)).rejects.toThrow(
			/date-start is missing or invalid/
		);
	});

	it('keeps showing the held answer when the refetch fails', async () => {
		const store = new MemoryCacheStore();
		await drain(stayAt('hostelworld'), store, fixtureFetch());
		const answers = await drain(stayAt('hostelworld'), store, fixtureFetch(500, { oops: true }));
		expect(answers.map((answer) => answer.state)).toEqual(['stale', 'stale']);
		expect(answers[1].photos.byKind.dorm).toHaveLength(3);
	});
});

describe('roomPhotoQueryFor', () => {
	const itinerary = {
		nightsInConnection: 3,
		travellers: 2,
		freeTime: {
			start: { local: '2026-10-07T14:30', timeZone: 'Europe/London', utcOffsetMinutes: 60 }
		},
		stay: stayAt('hostelworld')
	} as unknown as Parameters<typeof roomPhotoQueryFor>[0];

	it('takes the check-in date off the local wall clock at the connection', () => {
		// AGENTS.md's whole timezone section. Normalising this to UTC and formatting it back is
		// how an overnight stopover loses a night, and a lost night is a wrong price.
		expect(roomPhotoQueryFor(itinerary)).toEqual({
			checkIn: '2026-10-07',
			nights: 3,
			guests: 2,
			currency: 'EUR'
		});
	});

	it('has nothing to ask about a trip with no bed in it', () => {
		expect(roomPhotoQueryFor({ ...itinerary, stay: undefined } as typeof itinerary)).toBeUndefined();
	});

	it('has nothing to ask about a stopover with no night in it', () => {
		expect(
			roomPhotoQueryFor({ ...itinerary, nightsInConnection: 0 } as typeof itinerary)
		).toBeUndefined();
	});
});
