/**
 * OSRM adapter: walking and driving durations from the public, keyless OSRM demo
 * infrastructure, plus a taxi fare *estimate* derived from driving distance and a
 * per-country rate table (taxi-rate-table.ts) — never a quote.
 *
 * Issue #9. Implements TransferProvider (issue #2, ../types.ts) for the walk/drive
 * modes, plus two additional exports (`findTransfersToMany`, `getTaxiFareEstimate`)
 * that fall outside that interface's one-pair-at-a-time shape — see their own comments
 * for why they exist alongside it rather than being folded into `searchTransfers`.
 *
 * ## Why this file does not call router.project-osrm.org for anything but driving
 *
 * The issue's brief (and docs/PROVIDERS.md) points at
 * `https://router.project-osrm.org/route/v1/{profile}/...` and calls it "verified,
 * CORS *". That CORS claim is correct, but the profile handling is not: as of
 * 2026-09-04 that host's `{profile}` URL segment is ignored entirely — `walking`,
 * `driving` and even a made-up profile name all return the exact same result (same
 * distance, same duration, same speed of ~51 km/h) for a fixed test pair, because the
 * demo currently answers every request with its car network regardless of what the URL
 * asks for. This matches a long-standing, previously reported OSRM issue
 * (Project-OSRM/osrm-backend#4868 — "profile appears hardcoded to driving"), so it is
 * not a one-off fluke of this session.
 *
 * A "walking time" that is silently a car-speed number is exactly the failure mode
 * AGENTS.md warns about ("never present an estimate as a fact") — except worse, since
 * nothing here would even label it as uncertain. `routing.openstreetmap.de`, the other
 * FOSSGIS-sponsored demo host documented on the same OSRM wiki page, does route foot
 * traffic correctly: the same test pair came back at a plausible ~4.5 km/h on its
 * `/routed-foot/` service versus ~51 km/h on its `/routed-car/` service. Both hosts
 * verified with CORS `*`. So this adapter uses `routing.openstreetmap.de` throughout,
 * selecting the profile by path PREFIX (`routed-foot` / `routed-car`), which is what
 * that host actually keys behaviour off — not the `{profile}` segment later in the
 * path, which on this infrastructure is closer to decoration than a real parameter.
 */

import { defineCacheKey, getDefaultStore } from '../../cache';
import type { CacheKey, CacheStore } from '../../cache';
import type {
	Coordinates,
	Duration,
	IsoCountryCode,
	Transfer,
	TransferLeg,
	TransferMode
} from '../../domain';
import type {
	ProviderContext,
	ProviderError,
	ProviderHealth,
	ProviderId,
	ProviderResult,
	ProviderSource,
	TransferProvider,
	TransferSearchQuery
} from '../types';
import { estimateTaxiFare } from './taxi-rate-table';
import type { TaxiFareEstimate } from './taxi-rate-table';

export { estimateTaxiFare, TAXI_RATE_TABLE } from './taxi-rate-table';
export type { TaxiFareEstimate } from './taxi-rate-table';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const OSRM_PROVIDER_ID: ProviderId = 'osrm';

const DEFAULT_BASE_URL = 'https://routing.openstreetmap.de';

// Geography does not change week to week the way a fare does. AGENTS.md's "stale
// first, then fresh" rule (always refetch, show the old value meanwhile) is written
// for prices; applied here it would mean every repeated lookup of the same
// hotel-to-airport pair re-hits a volunteer-run demo server for a number that has not
// moved, which is exactly what issue #9 asks this adapter not to do ("respect the
// public demo server ... do not fire a request per hotel candidate without thought").
// So this adapter is cache-first (see readFreshEntry/writeEntry) rather than routed
// through staleWhileRevalidate: a fresh hit costs zero network requests, not one plus
// a background refetch every single time it is read.
const ROUTE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The wiki page for this demo infrastructure asks callers not to exceed 1 request per
// second. This is a shared, volunteer-run resource with no key and no per-caller
// quota to enforce that from the server side, so the client keeps to it voluntarily.
// Skipped when a caller supplies their own fetchImpl (tests), since that is never the
// real network.
const MIN_GAP_BETWEEN_REQUESTS_MS = 1100;
let lastRequestAt = 0;

// A point deep inside a real city's road network (Barcelona, Plaça de Catalunya)
// rather than an arbitrary lat/lon — OSRM's nearest-node snap can fail far from any
// mapped road, and a health check that fails because it probed open water would be a
// false alarm about the server, not a true one.
const HEALTH_CHECK_POINT: Coordinates = { latitude: 41.3874, longitude: 2.1686 };

export interface OsrmProviderOptions {
	/** Overrides the default IndexedDB-or-memory store. Mainly for tests. */
	store?: CacheStore;
	/** Overrides the global `fetch`. Mainly for tests — also disables the client-side
	 * rate limit, since a caller supplying their own fetch is never hitting the real
	 * shared server. */
	fetchImpl?: typeof fetch;
	/** Overrides the demo server's base URL. Mainly for tests, or a future self-hosted
	 * instance reachable at one origin (see the file header for why profile selection
	 * assumes the `routed-{profile}` path-prefix convention specifically). */
	baseUrl?: string;
}

type OsrmRoutableMode = Extract<TransferMode, 'walk' | 'drive'>;
type OsrmProfile = 'walking' | 'driving';

function toProfile(mode: OsrmRoutableMode): OsrmProfile {
	return mode === 'walk' ? 'walking' : 'driving';
}

/** Which backend instance answers (servicePrefix) and what the URL's own decorative
 * profile segment should read (urlProfile) — see the file header. */
const PROFILE_PATHS: Record<OsrmProfile, { servicePrefix: string; urlProfile: string }> = {
	walking: { servicePrefix: 'routed-foot', urlProfile: 'foot' },
	driving: { servicePrefix: 'routed-car', urlProfile: 'driving' }
};

const SUPPORTED_MODES: readonly TransferMode[] = ['walk', 'drive', 'taxi'];

// ---------------------------------------------------------------------------
// Errors: distinguished so a genuine "no path exists between these points" (a
// legitimate, expected result — an island with no bridge, say) never gets confused
// with a real infrastructure failure that should surface as a ProviderError.
// ---------------------------------------------------------------------------

class OsrmNoRouteError extends Error {}
class OsrmNetworkError extends Error {}
class OsrmMalformedResponseError extends Error {}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

/** Issue #68: OSRM's own numeric fields (`routes[].duration`/`.distance`,
 * `durations[][]`) get read straight off the parsed JSON body with no runtime check today.
 * OSRM is a stable, self-hosted FOSS project rather than the RapidAPI scraper listings this
 * issue was mainly opened over, but the same failure shape still applies: a non-numeric
 * value here would silently become `NaN` (`Math.round(NaN / 60)` is `NaN`, not a thrown
 * error) and propagate into a `Transfer.duration` an itinerary then does arithmetic on. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function toProviderError(error: unknown): ProviderError {
	if (isAbortError(error)) {
		return { code: 'cancelled', message: 'the request was aborted' };
	}
	if (error instanceof OsrmNetworkError) {
		return { code: 'network-error', message: error.message };
	}
	if (error instanceof OsrmMalformedResponseError) {
		return { code: 'malformed-response', message: error.message };
	}
	if (error instanceof Error) {
		return { code: 'unknown', message: error.message, cause: error };
	}
	return { code: 'unknown', message: String(error) };
}

function makeSource(): ProviderSource {
	return { providerId: OSRM_PROVIDER_ID, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

function assertValidCoordinates(point: Coordinates, label: string): void {
	if (!(point.latitude >= -90 && point.latitude <= 90)) {
		throw new Error(
			`${label}.latitude (${point.latitude}) is out of range — did you swap latitude and longitude?`
		);
	}
	if (!(point.longitude >= -180 && point.longitude <= 180)) {
		throw new Error(
			`${label}.longitude (${point.longitude}) is out of range — did you swap latitude and longitude?`
		);
	}
}

// 5 decimal places is roughly 1.1m of precision at the equator: enough to tell two
// hotels apart, coarse enough that the same point read from two different provider
// payloads (float noise from a different parser or rounding) collapses onto one cache
// entry instead of missing on a difference nobody could see on a map.
function roundCoordinate(value: number): number {
	return Math.round(value * 1e5) / 1e5;
}

// OSRM takes "{lon},{lat}" — the reverse of this codebase's {latitude, longitude} and
// of most other APIs. Every OSRM URL in this file is built through this one function
// so the swap happens in exactly one place rather than being re-derived (and possibly
// gotten backwards) at each call site — see the issue's own warning about this.
function toOsrmCoordinate(point: Coordinates): string {
	return `${roundCoordinate(point.longitude)},${roundCoordinate(point.latitude)}`;
}

// ---------------------------------------------------------------------------
// Low-level HTTP
// ---------------------------------------------------------------------------

interface OsrmResponseBase {
	code: string;
	message?: string;
}

async function waitForRateLimit(): Promise<void> {
	const elapsed = Date.now() - lastRequestAt;
	if (elapsed < MIN_GAP_BETWEEN_REQUESTS_MS) {
		await new Promise((resolve) => setTimeout(resolve, MIN_GAP_BETWEEN_REQUESTS_MS - elapsed));
	}
	lastRequestAt = Date.now();
}

async function requestOsrm<T extends OsrmResponseBase>(
	profile: OsrmProfile,
	service: 'route' | 'table' | 'nearest',
	pathSuffix: string,
	params: Record<string, string>,
	options: OsrmProviderOptions,
	signal: AbortSignal
): Promise<T> {
	const { servicePrefix, urlProfile } = PROFILE_PATHS[profile];
	const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
	const url = new URL(`${baseUrl}/${servicePrefix}/${service}/v1/${urlProfile}/${pathSuffix}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

	const fetchImpl = options.fetchImpl ?? fetch;
	if (!options.fetchImpl) await waitForRateLimit();

	let response: Response;
	try {
		response = await fetchImpl(url.toString(), { signal });
	} catch (error) {
		if (isAbortError(error)) throw error;
		throw new OsrmNetworkError(
			`request to ${url.pathname} failed before a response arrived: ${String(error)}`
		);
	}
	if (!response.ok) {
		throw new OsrmNetworkError(`request to ${url.pathname} returned HTTP ${response.status}`);
	}

	let rawBody: unknown;
	try {
		rawBody = await response.json();
	} catch {
		throw new OsrmMalformedResponseError(`response from ${url.pathname} was not valid JSON`);
	}
	if (typeof rawBody !== 'object' || rawBody === null || typeof (rawBody as { code?: unknown }).code !== 'string') {
		throw new OsrmMalformedResponseError(
			`response from ${url.pathname} did not have the expected OSRM response shape (missing a string "code")`
		);
	}
	const body = rawBody as T;

	if (body.code === 'NoRoute' || body.code === 'NoTable' || body.code === 'NoSegment') {
		throw new OsrmNoRouteError(body.message ?? `OSRM returned ${body.code}`);
	}
	if (body.code !== 'Ok') {
		throw new OsrmMalformedResponseError(
			`${url.pathname} returned code "${body.code}"${body.message ? `: ${body.message}` : ''}`
		);
	}
	return body;
}

// ---------------------------------------------------------------------------
// Cache (direct store access, cache-first — see the ROUTE_CACHE_TTL_MS comment above
// for why this deliberately does not use staleWhileRevalidate)
// ---------------------------------------------------------------------------

interface RouteData {
	durationSeconds: number;
	/** Absent for an entry written by the batched table lookup (findTransfersToMany),
	 * which never asks OSRM for distance since nothing that calls it needs one. A
	 * caller that does need distance (getTaxiFareEstimate) treats such an entry as a
	 * miss and fetches a full single route instead of guessing. */
	distanceMeters?: number;
}

function routeCacheKey(profile: OsrmProfile, origin: Coordinates, destination: Coordinates): CacheKey {
	return defineCacheKey(
		OSRM_PROVIDER_ID,
		{
			service: 'route',
			profile,
			origin: { lat: roundCoordinate(origin.latitude), lon: roundCoordinate(origin.longitude) },
			destination: { lat: roundCoordinate(destination.latitude), lon: roundCoordinate(destination.longitude) }
		},
		ROUTE_CACHE_TTL_MS
	);
}

// Same shape as cache/size.ts's estimateByteSize, kept local rather than imported:
// that file is not part of the cache module's public surface (see cache/index.ts),
// and this is three lines of arithmetic, not a dependency worth reaching past the
// module boundary for.
function estimateSize(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
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
		sizeBytes: estimateSize(value)
	});
}

// ---------------------------------------------------------------------------
// Route / table fetchers
// ---------------------------------------------------------------------------

interface OsrmRouteResponse extends OsrmResponseBase {
	routes: { distance: number; duration: number }[];
}

async function fetchRoute(
	profile: OsrmProfile,
	origin: Coordinates,
	destination: Coordinates,
	options: OsrmProviderOptions,
	signal: AbortSignal
): Promise<RouteData> {
	const coords = `${toOsrmCoordinate(origin)};${toOsrmCoordinate(destination)}`;
	const body = await requestOsrm<OsrmRouteResponse>(
		profile,
		'route',
		coords,
		{ overview: 'false' },
		options,
		signal
	);
	if (!Array.isArray(body.routes)) {
		throw new OsrmMalformedResponseError('OSRM route response did not have a routes array');
	}
	const route = body.routes[0];
	if (!route) throw new OsrmNoRouteError('OSRM returned no route for this pair');
	if (!isFiniteNumber(route.duration) || !isFiniteNumber(route.distance)) {
		throw new OsrmMalformedResponseError('OSRM route had a non-numeric duration or distance');
	}
	return { durationSeconds: route.duration, distanceMeters: route.distance };
}

interface OsrmTableResponse extends OsrmResponseBase {
	durations: (number | null)[][];
}

/** One request for every destination in `destinations`, all measured from the same
 * `origin` — the batching primitive issue #9 asks for ("do not fire a request per
 * hotel candidate"). `undefined` in the result means OSRM found no route for that one
 * destination, kept distinct from a thrown error since one unreachable hotel among
 * many candidates is a normal result, not a failure of the whole lookup. */
async function fetchTableDurations(
	profile: OsrmProfile,
	origin: Coordinates,
	destinations: Coordinates[],
	options: OsrmProviderOptions,
	signal: AbortSignal
): Promise<Array<number | undefined>> {
	const allPoints = [origin, ...destinations];
	const coords = allPoints.map(toOsrmCoordinate).join(';');
	const destinationIndexes = destinations.map((_, index) => index + 1).join(';');
	const body = await requestOsrm<OsrmTableResponse>(
		profile,
		'table',
		coords,
		{ sources: '0', destinations: destinationIndexes, annotations: 'duration' },
		options,
		signal
	);
	if (!Array.isArray(body.durations)) {
		throw new OsrmMalformedResponseError('OSRM table response did not have a durations array');
	}
	const row = body.durations[0];
	if (!row) throw new OsrmNoRouteError('OSRM table response had no row for the origin');
	return row.map((duration) => {
		if (duration === null) return undefined;
		if (!isFiniteNumber(duration)) {
			throw new OsrmMalformedResponseError('OSRM table response had a non-numeric duration entry');
		}
		return duration;
	});
}

type CachedRouteOutcome =
	| { kind: 'value'; value: RouteData; requestMade: boolean }
	| { kind: 'skipped-over-budget' }
	| { kind: 'no-route' };

/** Cache-first single-pair lookup shared by searchTransfers and getTaxiFareEstimate.
 * `requireDistance` upgrades a duration-only cache hit (written by the batched table
 * lookup, which never asks for distance) into a fresh fetch, since a taxi estimate
 * must never guess at a distance it does not actually have. */
async function getCachedRoute(
	profile: OsrmProfile,
	origin: Coordinates,
	destination: Coordinates,
	ctx: ProviderContext,
	options: OsrmProviderOptions,
	store: CacheStore,
	requestsSoFar: number,
	requireDistance = false
): Promise<CachedRouteOutcome> {
	const key = routeCacheKey(profile, origin, destination);
	const cached = await readFreshEntry<RouteData>(store, key);
	if (cached && (!requireDistance || cached.distanceMeters !== undefined)) {
		return { kind: 'value', value: cached, requestMade: false };
	}

	if (ctx.maxRequests !== undefined && requestsSoFar >= ctx.maxRequests) {
		return { kind: 'skipped-over-budget' };
	}

	try {
		const fresh = await fetchRoute(profile, origin, destination, options, ctx.signal);
		await writeEntry(store, key, fresh);
		return { kind: 'value', value: fresh, requestMade: true };
	} catch (error) {
		if (error instanceof OsrmNoRouteError) return { kind: 'no-route' };
		throw error;
	}
}

function routeToTransfer(mode: TransferMode, route: RouteData): Transfer {
	const duration = Math.round(route.durationSeconds / 60) as Duration;
	const leg: TransferLeg = { mode, duration };
	return { mode, duration, legs: [leg] };
}

// ---------------------------------------------------------------------------
// TransferProvider
// ---------------------------------------------------------------------------

async function healthCheckImpl(ctx: ProviderContext, options: OsrmProviderOptions): Promise<ProviderHealth> {
	if (ctx.signal.aborted) {
		return {
			ok: false,
			error: { code: 'cancelled', message: 'signal already aborted' },
			source: makeSource(),
			requestsUsed: 0
		};
	}
	try {
		// A single /nearest lookup is the cheapest real request that still proves the
		// server is up and returning valid OSRM JSON, short of computing an actual route.
		await requestOsrm(
			'driving',
			'nearest',
			toOsrmCoordinate(HEALTH_CHECK_POINT),
			{ number: '1' },
			options,
			ctx.signal
		);
		return {
			ok: true,
			data: { message: 'OSRM demo server reachable' },
			source: makeSource(),
			requestsUsed: 1
		};
	} catch (error) {
		return { ok: false, error: toProviderError(error), source: makeSource(), requestsUsed: 1 };
	}
}

async function searchTransfersImpl(
	query: TransferSearchQuery,
	ctx: ProviderContext,
	options: OsrmProviderOptions
): Promise<ProviderResult<Transfer[]>> {
	if (ctx.signal.aborted) {
		return {
			ok: false,
			error: { code: 'cancelled', message: 'signal already aborted' },
			source: makeSource(),
			requestsUsed: 0
		};
	}

	const requestedModes = (query.modes ?? SUPPORTED_MODES).filter((mode) => SUPPORTED_MODES.includes(mode));
	if (requestedModes.length === 0) {
		// Not this adapter's modes to serve (e.g. only 'transit' was asked for) — an
		// empty, ok result, the same way a search fans out across many adapters and lets
		// each contribute only what it actually has.
		return { ok: true, data: [], source: makeSource(), requestsUsed: 0 };
	}

	let requestsUsed = 0;
	try {
		assertValidCoordinates(query.from, 'query.from');
		assertValidCoordinates(query.to, 'query.to');

		const store = options.store ?? (await getDefaultStore());
		const results: Transfer[] = [];

		if (requestedModes.includes('walk')) {
			const outcome = await getCachedRoute(
				'walking',
				query.from,
				query.to,
				ctx,
				options,
				store,
				requestsUsed
			);
			if (outcome.kind === 'value') {
				if (outcome.requestMade) requestsUsed++;
				results.push(routeToTransfer('walk', outcome.value));
			}
			// 'no-route' and 'skipped-over-budget' both mean no walking Transfer this
			// time — a normal partial result (AGENTS.md: "partial results are the normal
			// case"), not a failure of the whole call.
		}

		// 'drive' and 'taxi' both ride the same road network, so one driving route
		// answers both — a taxi does not get its own physics. This halves the network
		// cost of a query that asks for both compared to fetching them separately.
		if (requestedModes.includes('drive') || requestedModes.includes('taxi')) {
			const outcome = await getCachedRoute(
				'driving',
				query.from,
				query.to,
				ctx,
				options,
				store,
				requestsUsed
			);
			if (outcome.kind === 'value') {
				if (outcome.requestMade) requestsUsed++;
				if (requestedModes.includes('drive')) results.push(routeToTransfer('drive', outcome.value));
				if (requestedModes.includes('taxi')) {
					// price is deliberately left unset here, never guessed at: a `Transfer`
					// carries a real `Money` or nothing. The distance-based range lives in
					// getTaxiFareEstimate below, in a type that cannot be mistaken for one.
					results.push(routeToTransfer('taxi', outcome.value));
				}
			}
		}

		return { ok: true, data: results, source: makeSource(), requestsUsed };
	} catch (error) {
		return { ok: false, error: toProviderError(error), source: makeSource(), requestsUsed };
	}
}

/** Builds an OSRM-backed TransferProvider. A factory rather than a bare singleton so
 * a caller (or a test) can inject a store, a fetch implementation, or an alternate
 * base URL without any global state. `osrmTransferProvider` below is the default
 * instance for normal use. */
export function createOsrmTransferProvider(options: OsrmProviderOptions = {}): TransferProvider {
	return {
		kind: 'transfer',
		id: OSRM_PROVIDER_ID,
		label: 'OSRM (walking & driving)',
		needsKey: false,
		keyFields: [],
		healthCheck: (ctx) => healthCheckImpl(ctx, options),
		searchTransfers: (query, ctx) => searchTransfersImpl(query, ctx, options)
	};
}

/** Ready-to-register default instance — most callers want this, not
 * `createOsrmTransferProvider()` with no reason to override anything. Registry wiring
 * (adding this to whatever assembles the app's live ProviderRegistry) is a follow-up:
 * no such assembly file exists on main yet, and inventing one here would risk
 * colliding with another issue's version of it. */
export const osrmTransferProvider = createOsrmTransferProvider();

// ---------------------------------------------------------------------------
// Batch helper — outside TransferProvider on purpose: TransferSearchQuery is one
// origin to one destination, but ranking hotel candidates near a connection (brief
// line 76) means one origin against many candidates, and OSRM's table service answers
// that in a single request. Folding this into searchTransfers would either force a
// query shape TransferProvider does not have, or silently turn "many candidates" into
// many single-pair calls — precisely what issue #9 says not to do.
// ---------------------------------------------------------------------------

/**
 * Walking or driving duration from one `origin` to each of `destinations`, in the
 * same order, `undefined` where OSRM found no route. Already-cached pairs cost no
 * network call at all; every cache miss is answered by exactly one table request
 * regardless of how many misses there are.
 */
export async function findTransfersToMany(
	mode: OsrmRoutableMode,
	origin: Coordinates,
	destinations: Coordinates[],
	ctx: ProviderContext,
	options: OsrmProviderOptions = {}
): Promise<ProviderResult<Array<Transfer | undefined>>> {
	if (ctx.signal.aborted) {
		return {
			ok: false,
			error: { code: 'cancelled', message: 'signal already aborted' },
			source: makeSource(),
			requestsUsed: 0
		};
	}
	if (destinations.length === 0) {
		return { ok: true, data: [], source: makeSource(), requestsUsed: 0 };
	}

	let requestsUsed = 0;
	try {
		assertValidCoordinates(origin, 'origin');
		destinations.forEach((destination, index) => assertValidCoordinates(destination, `destinations[${index}]`));

		const store = options.store ?? (await getDefaultStore());
		const profile = toProfile(mode);
		const keys = destinations.map((destination) => routeCacheKey(profile, origin, destination));
		const cachedValues = await Promise.all(keys.map((key) => readFreshEntry<RouteData>(store, key)));

		const missingIndexes: number[] = [];
		cachedValues.forEach((value, index) => {
			if (value === undefined) missingIndexes.push(index);
		});

		const results: Array<Transfer | undefined> = cachedValues.map((value) =>
			value ? routeToTransfer(mode, value) : undefined
		);

		if (missingIndexes.length > 0) {
			if (ctx.maxRequests !== undefined && requestsUsed >= ctx.maxRequests) {
				// Budget already spent before this batch could even start — return the
				// cache hits gathered so far rather than exceeding it.
				return { ok: true, data: results, source: makeSource(), requestsUsed };
			}

			const durationsSeconds = await fetchTableDurations(
				profile,
				origin,
				missingIndexes.map((index) => destinations[index]),
				options,
				ctx.signal
			);
			requestsUsed += 1;

			await Promise.all(
				missingIndexes.map(async (destinationIndex, fetchedIndex) => {
					const durationSeconds = durationsSeconds[fetchedIndex];
					if (durationSeconds === undefined) return; // unreachable from the origin
					const route: RouteData = { durationSeconds };
					results[destinationIndex] = routeToTransfer(mode, route);
					await writeEntry(store, keys[destinationIndex], route);
				})
			);
		}

		return { ok: true, data: results, source: makeSource(), requestsUsed };
	} catch (error) {
		return { ok: false, error: toProviderError(error), source: makeSource(), requestsUsed };
	}
}

// ---------------------------------------------------------------------------
// Taxi fare estimate — outside TransferProvider on purpose: `Transfer.price` is a
// `Money`, a single number a UI can print as a confirmed fare. Nothing this function
// produces is confirmed — it is a driving distance run through a per-country rate
// table — so it is returned as its own type instead, one a caller has to deliberately
// reach past `Transfer` to get, and cannot accidentally assign to `Transfer.price`.
// ---------------------------------------------------------------------------

export interface TaxiFareResult {
	/** Real, from the OSRM driving route between the two points — not an estimate. */
	duration: Duration;
	distanceMeters: number;
	/** Distance-based approximation from TAXI_RATE_TABLE. Always a range; never a
	 * quote. See taxi-rate-table.ts. */
	fareEstimate: TaxiFareEstimate;
}

/**
 * Estimates what a taxi would cost for this route: a real driving duration and
 * distance from OSRM, run through the per-country rate table in taxi-rate-table.ts.
 * Brief line 77 / issue #9: this is the transport floor for when transit has stopped
 * running — whether the taxi fare still leaves the itinerary worth it is exactly the
 * question a range, not a single confident number, is honest about.
 */
export async function getTaxiFareEstimate(
	origin: Coordinates,
	destination: Coordinates,
	countryCode: IsoCountryCode,
	ctx: ProviderContext,
	options: OsrmProviderOptions = {}
): Promise<ProviderResult<TaxiFareResult>> {
	if (ctx.signal.aborted) {
		return {
			ok: false,
			error: { code: 'cancelled', message: 'signal already aborted' },
			source: makeSource(),
			requestsUsed: 0
		};
	}

	let requestsUsed = 0;
	try {
		assertValidCoordinates(origin, 'origin');
		assertValidCoordinates(destination, 'destination');

		const store = options.store ?? (await getDefaultStore());
		const outcome = await getCachedRoute(
			'driving',
			origin,
			destination,
			ctx,
			options,
			store,
			requestsUsed,
			true
		);

		if (outcome.kind === 'no-route') {
			return {
				ok: false,
				error: { code: 'unknown', message: 'OSRM found no driving route between these points' },
				source: makeSource(),
				requestsUsed
			};
		}
		if (outcome.kind === 'skipped-over-budget') {
			return {
				ok: false,
				error: { code: 'unknown', message: 'request budget was exhausted before a route could be fetched' },
				source: makeSource(),
				requestsUsed
			};
		}
		if (outcome.requestMade) requestsUsed++;

		const { distanceMeters, durationSeconds } = outcome.value;
		if (distanceMeters === undefined) {
			// requireDistance=true above guarantees a cache hit without a distance is
			// treated as a miss and re-fetched in full — this branch documents that
			// invariant rather than silently trusting it with a non-null assertion.
			throw new Error('OSRM route was missing a distance despite requireDistance being set');
		}

		return {
			ok: true,
			data: {
				duration: Math.round(durationSeconds / 60) as Duration,
				distanceMeters: Math.round(distanceMeters),
				fareEstimate: estimateTaxiFare(distanceMeters, countryCode)
			},
			source: makeSource(),
			requestsUsed
		};
	} catch (error) {
		return { ok: false, error: toProviderError(error), source: makeSource(), requestsUsed };
	}
}
