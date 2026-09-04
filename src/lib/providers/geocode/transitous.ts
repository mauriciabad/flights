/**
 * Transitous-backed geocoding (issue #64): free-text search for the search form's origin
 * and destination location fields, plus a live IATA-code-to-timezone lookup for flight
 * adapters. Orchestration only — HTTP lives in transitous-client.ts, response shaping in
 * transitous-mapper.ts, same split as the transfers adapter. This file's own job is
 * caching and turning whatever the client throws into a `ProviderResult`.
 *
 * Not a registered `AnyProvider` (types.ts `ProviderKindMap` has no `'geocode'` kind).
 * Geocoding does not fit the "search offers across many adapters, fan out through the
 * registry" shape flight/stay/transfer/airport-data share — it is one keyless source
 * called directly, the same reasoning transfers/osrm.ts gives for keeping its batch
 * helper and taxi estimate outside `TransferProvider`. Adding a fifth provider kind to
 * that chokepoint for a single adapter would risk exactly the seam AGENTS.md warns about
 * ("two agents ... both correct at the moment they looked and both wrong by the time they
 * finished") for no caller that actually needs it yet.
 *
 * ## Why IATA-to-timezone uses reverse-geocode, not a text search
 *
 * The obvious-looking approach — search `"<IATA> Airport"` as free text — was tried and
 * rejected. Querying `text=BCN` resolves to a hamlet in the Swiss canton of Fribourg
 * (Transitous's own scoring has no idea "BCN" should mean an airport), and even
 * `text=BCN Airport` surfaces airports in Kobe and Naha that happen to also match the word
 * "Airport" more strongly than a bare 3-letter code. `text=Vienna Airport` DID resolve
 * correctly, so this isn't a total failure of text search, but it isn't reliable enough
 * to drop an offer over the way `skyscanner-timezone.ts` already drops offers for airports
 * missing from its curated table — trading one silent gap for a different silent wrong
 * answer would not be progress.
 *
 * `/reverse-geocode?place=lat,lon`, fed the airport's own coordinates from this app's
 * OurAirports-derived dataset (`data/airports.ts`, issue #11 — already exact, since that
 * is a runway survey, not a geocoder's guess), was checked against 16 airports on every
 * populated continent (BCN, VIE, JFK, LAX, SYD, DXB, NRT, GRU, JNB, SIN, LHR, ANC, CPT,
 * HND, GIG, AKL) on 2026-09-04 and returned the correct IANA zone for every one, including
 * the DST-observing, half-hour-offset and antipodal cases. The only miss in that session
 * was a typo in the test coordinate, not a service gap. See the PR for the full transcript.
 */

import { getAirport } from '../../data/airports';
import type { Coordinates, IataAirportCode } from '../../domain';
import type { CacheKey, CacheStore } from '../../cache';
import { defineCacheKey, getDefaultStore } from '../../cache';
import type { ProviderContext, ProviderError, ProviderResult, ProviderSource } from '../types';
import {
	fetchTransitousGeocode,
	fetchTransitousReverseGeocode,
	TransitousHttpError,
	TransitousMalformedResponseError
} from './transitous-client';
import { mapGeocodeResponseToCandidates } from './transitous-mapper';
import type { GeocodeCandidate } from './types';

export const GEOCODE_PROVIDER_ID = 'transitous-geocode';

/**
 * A place's coordinates, and the administrative areas that contain it, do not move
 * (issue #64: "cache hard... LONG TTL, because a place's coordinates do not move. That is
 * the opposite of prices"). 90 days is longer than transfers/osrm.ts's 30-day road-network
 * TTL on purpose — a road can get rerouted around new construction, a city cannot move —
 * and still short enough that a genuinely stale entry (a demolished landmark someone
 * searched by name) ages out within a season rather than living forever.
 */
const LONG_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface GeocodeProviderOptions {
	/** Overrides the global `fetch`, for tests only. */
	fetchImpl?: typeof fetch;
	/** Overrides the default IndexedDB-or-memory cache store, for tests only. */
	resolveStore?: () => Promise<CacheStore>;
}

/**
 * Free-text location search for the search form's origin/destination fields (issue #64).
 * Always resolves `ok: true` with however many candidates Transitous found, including
 * zero for a query that matches nothing — "no results" is data, not a failure, same
 * convention as every other adapter in this codebase. Never picks one for the caller:
 * "Barcelona" must come back as Spain, Venezuela and the Philippines all at once so a
 * person can tell them apart by `areas`/`countryCode`, not have the app guess.
 */
export async function searchLocations(
	query: string,
	ctx: ProviderContext,
	options: GeocodeProviderOptions = {}
): Promise<ProviderResult<GeocodeCandidate[]>> {
	const trimmed = query.trim();
	if (!trimmed) {
		return { ok: true, data: [], source: makeSource(), requestsUsed: 0 };
	}

	const resolveStore = options.resolveStore ?? getDefaultStore;
	const cacheKey = defineCacheKey(GEOCODE_PROVIDER_ID, { op: 'search', text: trimmed.toLowerCase() }, LONG_CACHE_TTL_MS);

	try {
		const store = await resolveStore();
		const cached = await readFreshEntry<GeocodeCandidate[]>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached, source: makeSource(), requestsUsed: 0 };
		}

		const response = await fetchTransitousGeocode(trimmed, { signal: ctx.signal, fetchImpl: options.fetchImpl });
		const candidates = mapGeocodeResponseToCandidates(response);
		await writeEntry(store, cacheKey, candidates);
		return { ok: true, data: candidates, source: makeSource(), requestsUsed: 1 };
	} catch (cause) {
		return mapThrownToResult(cause);
	}
}

/**
 * Timezone for an arbitrary point, via Transitous's reverse-geocoder. The building block
 * `lookupAirportTimeZone` below is written on top of, kept exported in its own right since
 * a search-form `Location` (a traveller's own address, not necessarily an airport) needs a
 * timezone just as much as an airport does for the same overnight-connection reasons
 * AGENTS.md calls out.
 */
export async function lookupTimeZoneForCoordinates(
	coordinates: Coordinates,
	ctx: ProviderContext,
	options: GeocodeProviderOptions = {}
): Promise<ProviderResult<string | undefined>> {
	const resolveStore = options.resolveStore ?? getDefaultStore;
	// Rounded to ~1.1m precision (5 decimal places at the equator) so two callers asking
	// about essentially the same point — a hotel and the airport it sits next to, say —
	// share one cache entry instead of missing on float noise, same rounding
	// transfers/osrm.ts uses for its own coordinate cache keys.
	const rounded = { latitude: round(coordinates.latitude), longitude: round(coordinates.longitude) };
	const cacheKey = defineCacheKey(GEOCODE_PROVIDER_ID, { op: 'reverse', ...rounded }, LONG_CACHE_TTL_MS);

	try {
		const store = await resolveStore();
		// A cache entry always holds a wrapper object, never a bare `string | undefined`,
		// so "Transitous had nothing at this point" is a cached fact (an entry whose
		// `timeZone` is `undefined`), distinguishable from "never looked this point up
		// before" (no entry at all) — the same "absence is data" convention
		// transfers/transitous.ts uses for an empty `Transfer[]`.
		const cached = await readFreshEntry<{ timeZone: string | undefined }>(store, cacheKey);
		if (cached) {
			return { ok: true, data: cached.timeZone, source: makeSource(), requestsUsed: 0 };
		}

		const response = await fetchTransitousReverseGeocode(coordinates, {
			signal: ctx.signal,
			fetchImpl: options.fetchImpl
		});
		const [nearest] = mapGeocodeResponseToCandidates(response);
		const timeZone = nearest?.timeZone;
		await writeEntry(store, cacheKey, { timeZone });
		return { ok: true, data: timeZone, source: makeSource(), requestsUsed: 1 };
	} catch (cause) {
		return mapThrownToResult(cause);
	}
}

/**
 * IATA code -> IANA timezone, live from Transitous rather than a hand-curated table
 * (issue #64's stated reason this capability is worth more than the search-form wiring:
 * `skyscanner-timezone.ts`'s table silently rots and drops any offer for an airport it
 * does not list). Deliberately NOT wired into that adapter in this PR — see this file's
 * header and the PR description for why that is its own follow-up.
 *
 * Resolves `ok: true, data: undefined` (never an error) when `iataCode` is not in this
 * app's own airport dataset — AGENTS.md: "say what you do not know rather than guessing",
 * and an unknown airport is a data gap, not a Transitous failure, so it must not spend a
 * network request only to report the same "unknown" a local lookup already knew for free.
 */
export async function lookupAirportTimeZone(
	iataCode: IataAirportCode,
	ctx: ProviderContext,
	options: GeocodeProviderOptions = {}
): Promise<ProviderResult<string | undefined>> {
	const airport = await getAirport(iataCode);
	if (!airport) {
		return { ok: true, data: undefined, source: makeSource(), requestsUsed: 0 };
	}
	return lookupTimeZoneForCoordinates(airport.coordinates, ctx, options);
}

function round(value: number): number {
	return Math.round(value * 1e5) / 1e5;
}

function makeSource(): ProviderSource {
	return { providerId: GEOCODE_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

async function readFreshEntry<T>(store: CacheStore, key: CacheKey): Promise<T | undefined> {
	const entry = await store.get(key.raw);
	if (!entry) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return entry.value as T;
}

async function writeEntry<T>(store: CacheStore, key: CacheKey, value: T): Promise<void> {
	const now = Date.now();
	await store.set({
		key: key.raw,
		providerId: key.providerId,
		value,
		storedAt: now,
		ttlMs: key.ttlMs,
		lastAccessedAt: now,
		sizeBytes: JSON.stringify(value).length
	});
}

function isAbortError(cause: unknown): boolean {
	return (
		(cause instanceof DOMException && cause.name === 'AbortError') ||
		(cause instanceof Error && cause.name === 'AbortError')
	);
}

/** Same error taxonomy as transfers/transitous.ts's `mapThrownToResult` — see that file's
 * comments for why each case is classified the way it is. Kept as its own small copy
 * rather than a shared export: the two are already identical in spirit through the
 * client-level reuse (transitous-client.ts imports the actual error classes and HTTP
 * constants from the transfers adapter), and this last step is thin enough — five cases,
 * no branching logic of its own — that sharing it would trade one import for another
 * without removing any real duplication. */
function mapThrownToResult<T>(cause: unknown): ProviderResult<T> {
	const source = makeSource();

	if (isAbortError(cause)) {
		return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled' }, source, requestsUsed: 0 };
	}

	if (cause instanceof TransitousHttpError) {
		const error: ProviderError =
			cause.status === 429
				? { code: 'quota-exceeded', message: cause.message, status: 429, retryAfterSeconds: cause.retryAfterSeconds }
				: { code: 'malformed-response', message: cause.message };
		return { ok: false, error, source, requestsUsed: 1 };
	}

	if (cause instanceof TransitousMalformedResponseError) {
		return {
			ok: false,
			error: { code: 'malformed-response', message: cause.message, cause: cause.cause },
			source,
			requestsUsed: 1
		};
	}

	if (cause instanceof TypeError) {
		return { ok: false, error: { code: 'network-error', message: cause.message, cause }, source, requestsUsed: 0 };
	}

	return {
		ok: false,
		error: { code: 'unknown', message: cause instanceof Error ? cause.message : String(cause), cause },
		source,
		requestsUsed: 1
	};
}
