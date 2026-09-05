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
	FareEstimate,
	IsoCountryCode,
	Transfer,
	TransferLeg,
	TransferMode
} from '../../domain';
import { greatCircleDistanceKm, MAX_PLAUSIBLE_WALK_MINUTES } from '../../domain';
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

export { estimateTaxiFare, TAXI_RATE_TABLE } from './taxi-rate-table';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const OSRM_PROVIDER_ID: ProviderId = 'osrm';

// Exported so tests/e2e/support/providers.ts's mockOsrm can intercept the same host
// this adapter actually calls, rather than keeping its own copy of the string that can
// drift the way it already did once (issue #132: the mock still pointed at
// router.project-osrm.org months after this adapter moved off it).
export const OSRM_BASE_URL = 'https://routing.openstreetmap.de';

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
export const MIN_GAP_BETWEEN_REQUESTS_MS = 1100;
let lastRequestAt = 0;

/**
 * Issue #213. The gap above is a promise to one shared server, so it has to hold across
 * every caller at once, and the arithmetic alone did not do that.
 *
 * `search/resources.ts` fetches both directions of a stopover's ground legs with
 * `Promise.all`, and every candidate stopover does the same, so a search reaches this
 * module with a dozen lookups already in flight. Each read `lastRequestAt`, found the same
 * stale value, computed the same delay and slept it — then all of them fired on the same
 * tick, one second late. A burst of twelve, not a trickle of one per second.
 *
 * Measured against a build of 57fa876 with tools/probe-osrm-requests.mjs: twelve requests,
 * all twelve distinct, and `routing.openstreetmap.de` refused five of them. Two minutes
 * later the same five returned 200. That is the signature of a shared instance pushing
 * back on a burst, and it is the same host that had refused this machine's traffic
 * entirely half an hour before (issue #213, third comment).
 *
 * Chaining the waits fixes the actual property wanted: each caller waits for the caller
 * before it to take its slot, so N concurrent lookups leave N gaps apart instead of
 * together. `waitForRateLimit` is deliberately not `async` — the link must be added to the
 * chain synchronously, on the caller's own tick, or two callers arriving on the same tick
 * both extend the same predecessor and share a slot.
 */
let requestChain: Promise<void> = Promise.resolve();

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
	/** Milliseconds this module leaves between two requests, across every concurrent
	 * caller. Defaults to `MIN_GAP_BETWEEN_REQUESTS_MS`, or to 0 when `fetchImpl` is set,
	 * so the existing tests stay instant. A test that wants to observe the spacing itself
	 * sets a small number here rather than waiting out the real one. */
	minGapBetweenRequestsMs?: number;
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

/**
 * An upper bound on how fast any pedestrian router could claim to walk, used only to turn
 * `MAX_PLAUSIBLE_WALK_MINUTES` into a distance this adapter can check BEFORE it asks.
 *
 * Deliberately faster than the ~4.5 km/h this host's foot profile was measured at (see the
 * file header). The gate must never reject a walk the router would have returned inside
 * the cap, and erring fast is the direction that cannot: at 6 km/h the gate only fires
 * beyond 4.5 km, where even an implausibly brisk walker is past 45 minutes, while the real
 * profile is already past it at 3.4.
 */
const FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR = 6;

/**
 * Issue #204: how far apart two points have to be before asking for a walking route is
 * pointless. Great-circle distance is a lower bound on any real path
 * (`domain/coordinates.ts`), so past this the route CANNOT come back under the cap.
 *
 * `search/resources.ts`'s `isPlausibleTransfer` has thrown these answers away since issue
 * #119, but throwing away an answer still costs the request that produced it. On
 * production, a stay 48 km from Gatwick had this adapter ask the shared FOSSGIS instance
 * for a 48 km foot route four times; every one came back `net::ERR_CONNECTION_RESET`, and
 * those were the only errors on the page. Asking was the bug, not the reset.
 */
const MAX_WALK_ROUTE_DISTANCE_KM =
	(FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR * MAX_PLAUSIBLE_WALK_MINUTES) / 60;

/** Whether a walking route between these two points could possibly be worth having. */
function walkIsWorthRouting(from: Coordinates, to: Coordinates): boolean {
	return greatCircleDistanceKm(from, to) <= MAX_WALK_ROUTE_DISTANCE_KM;
}

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

/** A plain `Error` rather than a `DOMException`, so `isAbortError` above recognises it in
 * every runtime this code runs in (browser, jsdom, node) without depending on whether
 * `DOMException` extends `Error` there. */
function abortError(message: string): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
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

/**
 * Issue #118: turns OSRM's GeoJSON `LineString` geometry (a plain `{type, coordinates}`
 * object once `geometries=geojson` is asked for — see `fetchRoute` below) into this
 * codebase's `Coordinates[]`, or `undefined` if the shape isn't what OSRM is documented
 * to send. Same "fail closed on a malformed shape rather than propagate garbage"
 * discipline as `isFiniteNumber` above (issue #68): a corrupted or future-changed
 * geometry object must degrade to "no path known" (the map's honest straight-line
 * fallback), never a `Transfer.path` full of `NaN`s or swapped lat/lon.
 */
function parseGeoJsonLineString(geometry: unknown): Coordinates[] | undefined {
	if (typeof geometry !== 'object' || geometry === null) return undefined;
	const coordinates = (geometry as { coordinates?: unknown }).coordinates;
	if (!Array.isArray(coordinates) || coordinates.length < 2) return undefined;

	const points: Coordinates[] = [];
	for (const pair of coordinates) {
		// OSRM's GeoJSON order is [longitude, latitude], like every GeoJSON geometry and
		// like every OSRM request URL this file builds (toOsrmCoordinate) — the reverse
		// of this codebase's own {latitude, longitude} field order.
		if (!Array.isArray(pair) || pair.length < 2) return undefined;
		const [longitude, latitude] = pair;
		if (!isFiniteNumber(longitude) || !isFiniteNumber(latitude)) return undefined;
		points.push({ latitude, longitude });
	}
	return points;
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

/**
 * `storedAt` is the epoch millis this data actually came off OSRM's wire. Omitted means
 * "just now", i.e. this call did the fetch.
 *
 * Passing it matters more than it looks. `ProviderSource.fetchedAt` is documented as "the
 * instant the adapter finished fetching this, NOT when a caller later reads it out of a
 * cache", and ResultCard renders it as "via OSRM · fetched 2 minutes ago". Stamping
 * `new Date()` on a cache hit, which is what this function used to do unconditionally,
 * made that footer say "fetched just now" about a route this adapter last saw a month ago
 * — AGENTS.md's "never present an estimate as a fact", in the one place the UI was already
 * built to be honest. Issue #151. The same pattern as transfers/transitous.ts.
 */
function makeSource(storedAt?: number): ProviderSource {
	return { providerId: OSRM_PROVIDER_ID, fetchedAt: new Date(storedAt ?? Date.now()).toISOString() };
}

/**
 * The older of two fetch instants, where `undefined` means "nothing served yet".
 *
 * A `ProviderResult` carries one `source` for however many `Transfer`s it holds, so a
 * result mixing a cached leg with a freshly fetched one has to pick a single stamp. The
 * oldest contributing part is the only one that cannot overstate the answer's age: a
 * reader deciding whether to trust a two-hour-old walking route must not be told the whole
 * result is as new as the driving leg fetched alongside it. Per-leg stamps would be more
 * precise, but that needs a shape change to `Transfer` itself, and this file cannot invent
 * one without colliding with the domain model.
 */
function olderFetchInstant(current: number | undefined, candidate: number): number {
	return current === undefined ? candidate : Math.min(current, candidate);
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

function waitForRateLimit(minGapMs: number): Promise<void> {
	const slot = requestChain.then(async () => {
		const elapsed = Date.now() - lastRequestAt;
		if (elapsed < minGapMs) {
			await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
		}
		lastRequestAt = Date.now();
	});
	// Swallowed on the chain only, never on `slot`: one caller's failure must not strand
	// every request queued behind it, and must still reach that caller.
	requestChain = slot.catch(() => undefined);
	return slot;
}

function gapFor(options: OsrmProviderOptions): number {
	return options.minGapBetweenRequestsMs ?? (options.fetchImpl ? 0 : MIN_GAP_BETWEEN_REQUESTS_MS);
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
	const baseUrl = options.baseUrl ?? OSRM_BASE_URL;
	const url = new URL(`${baseUrl}/${servicePrefix}/${service}/v1/${urlProfile}/${pathSuffix}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

	const fetchImpl = options.fetchImpl ?? fetch;
	const minGapMs = gapFor(options);
	// Checked before joining the queue as well as after leaving it: a cancelled search that
	// still took its slot would delay the search that replaced it by a second per lookup.
	if (signal.aborted) throw abortError('aborted before asking for a request slot');
	if (minGapMs > 0) await waitForRateLimit(minGapMs);
	if (signal.aborted) throw abortError('aborted while waiting for a request slot');

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
	/** Issue #118: the route's shape, present whenever `fetchRoute` got a well-formed
	 * geometry back — never set by the table lookup, which doesn't ask OSRM for one
	 * (see `distanceMeters`'s own comment; the same "entry from a different fetcher" gap
	 * applies here too, and callers already treat a path-less entry as "no shape known"
	 * rather than a bug). */
	path?: Coordinates[];
}

/**
 * `geometry: 'simplified-geojson'` is not a real query parameter — it is a discriminator
 * that exists purely so this key changes when the *shape of the cached value* changes.
 * Before this field existed, a route was fetched with `overview=false` and cached as
 * `{ durationSeconds, distanceMeters }`; `fetchRoute` now asks for
 * `overview=simplified&geometries=geojson` and caches `path` alongside those two. Both
 * versions hash to the exact same key for the same origin/destination/profile, and the
 * cache TTL is 30 days, so without this discriminator every entry written by the old
 * code would keep being read back as a "fresh" hit with no `path` for up to a month —
 * silently reverting this fix to a straight line for anyone who had already used the
 * app, the owner very much included. Bump this string again the next time this
 * function's cached value shape changes, for the same reason.
 */
const ROUTE_CACHE_SHAPE_VERSION = 'simplified-geojson';

function routeCacheKey(profile: OsrmProfile, origin: Coordinates, destination: Coordinates): CacheKey {
	return defineCacheKey(
		OSRM_PROVIDER_ID,
		{
			service: 'route',
			geometry: ROUTE_CACHE_SHAPE_VERSION,
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

/** The cached value and the instant it was really fetched. `storedAt` is returned rather
 * than dropped so a cache hit can be dated honestly — see `makeSource`. */
interface FreshEntry<T> {
	value: T;
	storedAt: number;
}

async function readFreshEntry<T>(store: CacheStore, key: CacheKey): Promise<FreshEntry<T> | undefined> {
	const entry = await store.get(key.raw);
	if (!entry) return undefined;
	if (Date.now() - entry.storedAt >= entry.ttlMs) return undefined;
	return { value: entry.value as T, storedAt: entry.storedAt };
}

/** Returns the `storedAt` it wrote, which is also the instant the caller finished
 * fetching the value — the number `makeSource` wants for a freshly fetched result. */
async function writeEntry<T>(store: CacheStore, key: CacheKey, value: T): Promise<number> {
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
	return now;
}

// ---------------------------------------------------------------------------
// Route / table fetchers
// ---------------------------------------------------------------------------

interface OsrmRouteResponse extends OsrmResponseBase {
	routes: { distance: number; duration: number; geometry?: unknown }[];
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
		// Issue #118: `overview=simplified` (OSRM's own default, tuned for exactly this —
		// drawing a route on a map, not turn-by-turn precision) plus
		// `geometries=geojson` asks this SAME request for the route's shape alongside
		// the duration/distance it was already fetching — one more field in the JSON
		// body, not a second request. `overview=false` (the previous value here) was
		// this file's own explicit choice to ask OSRM for nothing more than the number
		// this adapter used to need; there was never a request-count reason not to ask
		// for the shape too. `geometries=geojson` avoids also needing a polyline
		// decoder for OSRM's terser default encoding, at the cost of a larger response
		// body — worth it for `simplified`'s point count (tens, not hundreds).
		{ overview: 'simplified', geometries: 'geojson' },
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
	return {
		durationSeconds: route.duration,
		distanceMeters: route.distance,
		path: parseGeoJsonLineString(route.geometry)
	};
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
	/** `storedAt` dates the route itself: the cache entry's own stamp on a hit, the moment
	 * of the fetch when one was made. Never "when this outcome was read". */
	| { kind: 'value'; value: RouteData; requestMade: boolean; storedAt: number }
	| { kind: 'skipped-over-budget' }
	| { kind: 'no-route' };

/**
 * Routes currently being fetched, so several callers asking the same question at the same
 * moment share one answer. Issue #213: the cache is only consulted before a fetch starts,
 * so two lookups of the same pair that begin together both miss it and both fetch — and
 * since #213's queue above, the second one also costs a whole extra second of everyone
 * else's waiting. `search/resources.ts` fans out per candidate stopover, and candidates
 * routinely share a connection airport, which is the same collision `transitous.ts` keeps
 * its `revalidating` set for.
 *
 * Scoped to one search's `AbortSignal`, not to the module, because that is exactly the
 * scope where sharing is safe: everything under one signal is cancelled together, so a
 * sharer can never inherit an abort meant for somebody else's search. Weak, so a finished
 * search's entries go away with its signal.
 */
type InFlightRoute = Promise<{ value: RouteData; storedAt: number }>;
const inFlightRoutes = new WeakMap<AbortSignal, Map<string, InFlightRoute>>();

function inFlightFor(signal: AbortSignal): Map<string, InFlightRoute> {
	const existing = inFlightRoutes.get(signal);
	if (existing) return existing;
	const created = new Map<string, InFlightRoute>();
	inFlightRoutes.set(signal, created);
	return created;
}

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
	if (cached && (!requireDistance || cached.value.distanceMeters !== undefined)) {
		return { kind: 'value', value: cached.value, requestMade: false, storedAt: cached.storedAt };
	}

	if (ctx.maxRequests !== undefined && requestsSoFar >= ctx.maxRequests) {
		return { kind: 'skipped-over-budget' };
	}

	// `requireDistance` needs no second thought here: everything this map ever holds came
	// from `fetchRoute`, which always asks for distance. Only the batched table lookup
	// writes a duration-only entry, and it does not go through this function.
	const pending = inFlightFor(ctx.signal);
	const shared = pending.get(key.raw);
	if (shared) {
		try {
			const { value, storedAt } = await shared;
			return { kind: 'value', value, requestMade: false, storedAt };
		} catch (error) {
			if (error instanceof OsrmNoRouteError) return { kind: 'no-route' };
			throw error;
		}
	}

	const started = (async () => {
		const fresh = await fetchRoute(profile, origin, destination, options, ctx.signal);
		return { value: fresh, storedAt: await writeEntry(store, key, fresh) };
	})();
	pending.set(key.raw, started);
	try {
		const { value, storedAt } = await started;
		return { kind: 'value', value, requestMade: true, storedAt };
	} catch (error) {
		if (error instanceof OsrmNoRouteError) return { kind: 'no-route' };
		throw error;
	} finally {
		pending.delete(key.raw);
	}
}

function routeToTransfer(mode: TransferMode, route: RouteData): Transfer {
	const duration = Math.round(route.durationSeconds / 60) as Duration;
	const leg: TransferLeg = { mode, duration };
	return { mode, duration, legs: [leg], path: route.path };
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
	// The oldest route behind `results`, so a walk served from cache is not backdated to
	// the driving fetch made alongside it. See `olderFetchInstant`.
	let oldestStoredAt: number | undefined;
	try {
		assertValidCoordinates(query.from, 'query.from');
		assertValidCoordinates(query.to, 'query.to');

		const store = options.store ?? (await getDefaultStore());
		const results: Transfer[] = [];
		// Issue #204: the two profiles below are two independent journeys, and a failure of
		// one used to take the other with it. `getCachedRoute` rethrows anything that is
		// not `OsrmNoRouteError`, the walking lookup runs first, and the whole method sat
		// in one try/catch — so a walking request that failed skipped the driving lookup
		// entirely and returned `ok: false` for both.
		//
		// That is how a priced bed disappeared on production. A 48 km foot route reset the
		// connection, the driving route that would have reached the same bed was never
		// requested, `search/resources.ts` found no candidates, dropped the stay, and the
		// card said "No bed priced for this stopover" about a bed Hostelworld had quoted at
		// EUR 13.00. Each profile is now kept apart, per AGENTS.md's "partial results are
		// the normal case".
		//
		// A failure is still a failure when EVERY requested profile fails: an empty `ok`
		// result would read as "asked, and there is nothing here", which is the lie issues
		// #130 and #135 exist to stop.
		const failures: unknown[] = [];

		if (requestedModes.includes('walk')) {
			// Issue #204: the cheapest possible answer, and the only one that costs nothing.
			// A walk this long is one `isPlausibleTransfer` would discard anyway.
			if (walkIsWorthRouting(query.from, query.to)) {
				try {
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
						oldestStoredAt = olderFetchInstant(oldestStoredAt, outcome.storedAt);
						results.push(routeToTransfer('walk', outcome.value));
					}
					// 'no-route' and 'skipped-over-budget' both mean no walking Transfer this
					// time, a normal partial result rather than a failure of the whole call.
				} catch (error) {
					failures.push(error);
				}
			}
		}

		// 'drive' and 'taxi' both ride the same road network, so one driving route
		// answers both — a taxi does not get its own physics. This halves the network
		// cost of a query that asks for both compared to fetching them separately.
		if (requestedModes.includes('drive') || requestedModes.includes('taxi')) {
			try {
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
					oldestStoredAt = olderFetchInstant(oldestStoredAt, outcome.storedAt);
					if (requestedModes.includes('drive')) results.push(routeToTransfer('drive', outcome.value));
					if (requestedModes.includes('taxi')) {
						// price is deliberately left unset here, never guessed at: a `Transfer`
						// carries a real `Money` or nothing. The distance-based range lives in
						// getTaxiFareEstimate below, in a type that cannot be mistaken for one.
						results.push(routeToTransfer('taxi', outcome.value));
					}
				}
			} catch (error) {
				failures.push(error);
			}
		}

		if (results.length === 0 && failures.length > 0) {
			// Surface the provider's own first error verbatim, per AGENTS.md's "show the
			// error you got, never the one you assumed".
			return { ok: false, error: toProviderError(failures[0]), source: makeSource(), requestsUsed };
		}

		return { ok: true, data: results, source: makeSource(oldestStoredAt), requestsUsed };
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
		modes: SUPPORTED_MODES,
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
	// Legs here can be any mix of month-old cache hits and durations fetched by the table
	// request below, but one `ProviderResult` carries one `source`, so this tracks the
	// oldest leg that actually made it into `results` — see `olderFetchInstant`.
	let oldestStoredAt: number | undefined;
	try {
		assertValidCoordinates(origin, 'origin');
		destinations.forEach((destination, index) => assertValidCoordinates(destination, `destinations[${index}]`));

		const store = options.store ?? (await getDefaultStore());
		const profile = toProfile(mode);
		const keys = destinations.map((destination) => routeCacheKey(profile, origin, destination));
		const cachedEntries = await Promise.all(keys.map((key) => readFreshEntry<RouteData>(store, key)));

		const missingIndexes: number[] = [];
		cachedEntries.forEach((entry, index) => {
			if (entry === undefined) missingIndexes.push(index);
			else oldestStoredAt = olderFetchInstant(oldestStoredAt, entry.storedAt);
		});

		const results: Array<Transfer | undefined> = cachedEntries.map((entry) =>
			entry ? routeToTransfer(mode, entry.value) : undefined
		);

		if (missingIndexes.length > 0) {
			if (ctx.maxRequests !== undefined && requestsUsed >= ctx.maxRequests) {
				// Budget already spent before this batch could even start — return the
				// cache hits gathered so far rather than exceeding it.
				return { ok: true, data: results, source: makeSource(oldestStoredAt), requestsUsed };
			}

			const durationsSeconds = await fetchTableDurations(
				profile,
				origin,
				missingIndexes.map((index) => destinations[index]),
				options,
				ctx.signal
			);
			requestsUsed += 1;

			// The stamps are folded in after the writes settle rather than from inside
			// them: two concurrent read-modify-writes of `oldestStoredAt` can drop one
			// another's contribution, and a batch is exactly where several land at once.
			const freshStoredAt = await Promise.all(
				missingIndexes.map(async (destinationIndex, fetchedIndex) => {
					const durationSeconds = durationsSeconds[fetchedIndex];
					if (durationSeconds === undefined) return undefined; // unreachable from the origin
					const route: RouteData = { durationSeconds };
					results[destinationIndex] = routeToTransfer(mode, route);
					return writeEntry(store, keys[destinationIndex], route);
				})
			);
			for (const storedAt of freshStoredAt) {
				if (storedAt !== undefined) oldestStoredAt = olderFetchInstant(oldestStoredAt, storedAt);
			}
		}

		return { ok: true, data: results, source: makeSource(oldestStoredAt), requestsUsed };
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
	fareEstimate: FareEstimate;
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
			source: makeSource(outcome.storedAt),
			requestsUsed
		};
	} catch (error) {
		return { ok: false, error: toProviderError(error), source: makeSource(), requestsUsed };
	}
}
