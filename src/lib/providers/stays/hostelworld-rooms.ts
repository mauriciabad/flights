/**
 * One property's room photographs, fetched when somebody is looking at that property and
 * never for a list. Issue #449.
 *
 * ## Why this is on demand, with the number that decides it
 *
 * `tools/probe-hostelworld-rooms.mjs`, London city 3, three nights from 2026-10-07, EUR,
 * 2026-09-08, from a real browser page origin:
 *
 * | what | requests | wire bytes | wall clock |
 * | --- | --- | --- | --- |
 * | availability for one property | 1 | 6,416 | 399-434 ms |
 * | availability for all thirty | 30 | 89,550 | 603-7,014 ms |
 *
 * Thirty is 1.8x the whole search's own bytes for 30x its requests, to answer a question
 * about one property the traveller has open. One is 6.4 KB and under half a second. So the
 * caller asks for the property in front of the reader, and this file's whole job is to make
 * that one request cheap to repeat.
 *
 * ## Stale first, then fresh, which AGENTS.md asks for by name
 *
 * `staleWhileRevalidate` yields the cached answer at once when there is one and then yields
 * whatever comes back from the network, so a reader who opens the same hostel twice sees
 * photographs immediately and the second yield replaces them in place. On a cold cache it
 * yields once. On a refetch failure past the TTL it re-tags the held value rather than
 * blanking the carousel, which is the tier that module calls `expired-fallback`.
 *
 * ## What is cached is the reduced lookup, not the response
 *
 * The response is 63,969 bytes decoded and the lookup built from it is a few dozen URLs.
 * `hostelworld.ts` caches raw bodies for the opposite reason — its mapper re-runs on every
 * read, so a mapping change reaches old entries for free — and pays 292,798 bytes per city
 * for it. Here the ratio is the wrong way round, so the key carries a shape version instead
 * and a change to `RoomPhotoLookup` evicts rather than being served stale.
 */

import { defineCacheKey, staleWhileRevalidate } from '../../cache';
import type { CacheStore } from '../../cache';
import type { RoomPhotoLookup } from '../../domain';
import type { ProviderContext, ProviderError } from '../types';
import { fetchPropertyAvailability } from './hostelworld-client';
import { mapAvailabilityToRoomPhotos } from './hostelworld-mapper';
import { HOSTELWORLD_PROVIDER_ID } from './provider-ids';

/** The same window `hostelworld.ts` gives a city's prices. This is an availability response,
 * so which rooms are in it moves with the calendar even though the photographs never do. */
const ROOM_PHOTOS_TTL_MS = 60 * 60_000;

/**
 * Bumped whenever `RoomPhotoLookup` changes shape, and mixed into the key rather than
 * checked on the way out.
 *
 * `domain/stay.ts`'s `STAY_SHAPE_VERSION` carries the argument at length. The short version
 * is #131: a cached value is read back and used, never inspected and found wanting, so a
 * shape change under an unchanged key means the fix installs and the old value comes
 * straight back.
 */
const ROOM_PHOTO_SHAPE_VERSION = 1;

export interface HostelworldRoomPhotosQuery {
	/** `Stay.source.propertyId`, verbatim. */
	propertyId: string;
	/** Check-in, `YYYY-MM-DD`, local at the property. */
	checkIn: string;
	nights: number;
	guests: number;
	currency: string;
}

export interface HostelworldRoomPhotosOptions {
	store?: CacheStore;
	fetchImpl?: typeof fetch;
}

/** One answer, and whether it is the cached one or the one that just arrived. `requestsUsed`
 * is what this yield cost, so a caller can report a real number rather than an assumption. */
export interface RoomPhotosYield {
	photos: RoomPhotoLookup;
	state: 'stale' | 'fresh' | 'expired-fallback';
	requestsUsed: number;
}

/** Thrown inside the fetcher so `staleWhileRevalidate` can fall back to a held value, and
 * unwrapped by the caller so the provider's own words reach the screen. AGENTS.md: show the
 * error you got, never the one you assumed. */
export class HostelworldRoomPhotosError extends Error {
	readonly providerError: ProviderError;
	constructor(providerError: ProviderError) {
		super(providerError.message);
		this.name = 'HostelworldRoomPhotosError';
		this.providerError = providerError;
	}
}

export async function* hostelworldRoomPhotos(
	query: HostelworldRoomPhotosQuery,
	ctx: ProviderContext,
	options: HostelworldRoomPhotosOptions = {}
): AsyncGenerator<RoomPhotosYield, void, unknown> {
	const key = defineCacheKey(
		HOSTELWORLD_PROVIDER_ID,
		{
			op: 'propertyRoomPhotos',
			propertyId: query.propertyId,
			checkIn: query.checkIn,
			nights: query.nights,
			guests: query.guests,
			currency: query.currency,
			photoShape: ROOM_PHOTO_SHAPE_VERSION
		},
		ROOM_PHOTOS_TTL_MS
	);

	let requestsUsed = 0;
	const fetcher = async (): Promise<RoomPhotoLookup> => {
		requestsUsed += 1;
		const response = await fetchPropertyAvailability(
			{
				propertyId: query.propertyId,
				currency: query.currency,
				dateStart: query.checkIn,
				numNights: query.nights,
				guests: query.guests
			},
			{ signal: ctx.signal, fetchImpl: options.fetchImpl }
		);
		if (!response.ok) {
			throw new HostelworldRoomPhotosError(toProviderError(response.error));
		}
		return mapAvailabilityToRoomPhotos(response.data);
	};

	for await (const result of staleWhileRevalidate(key, fetcher, { store: options.store })) {
		yield { photos: result.value, state: result.state, requestsUsed };
	}
}

function toProviderError(error: {
	code: string;
	message: string;
	cause?: unknown;
	status?: number;
	retryAfterSeconds?: number;
}): ProviderError {
	switch (error.code) {
		case 'cancelled':
			return { code: 'cancelled', message: error.message };
		case 'network-error':
			return { code: 'network-error', message: error.message, cause: error.cause };
		case 'malformed-response':
			return { code: 'malformed-response', message: error.message, cause: error.cause };
		case 'rate-limited':
			// Keyless, so no plan is being exceeded. Hostelworld's own edge can still throttle,
			// and "back off and try later" is the right thing to say either way — the same call
			// `hostelworld.ts` makes for its own 429.
			return {
				code: 'quota-exceeded',
				message: error.message,
				status: 429,
				retryAfterSeconds: error.retryAfterSeconds
			};
		default:
			return { code: 'unknown', message: error.message, cause: { status: error.status } };
	}
}
