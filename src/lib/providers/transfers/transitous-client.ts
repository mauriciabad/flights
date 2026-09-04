/**
 * The only file in this adapter that touches the network. Talks to Transitous
 * (https://transitous.org), a free, volunteer-run aggregator of public transport GTFS
 * feeds behind a MOTIS v2 server, and throws typed errors on anything that isn't a usable
 * 2xx body — transitous.ts is the only caller and turns those into `ProviderResult`.
 *
 * ## The User-Agent requirement, and why it can't be honoured as asked
 *
 * Transitous's terms of use ask for a `User-Agent` naming the app and a contact
 * (docs/PROVIDERS.md: "Their terms require a User-Agent naming the app with contact
 * details"). This app has no backend (AGENTS.md rule 1) — every request is a browser
 * `fetch`, and `User-Agent` has been a forbidden header name in the Fetch standard since
 * its first draft: a browser silently drops whatever a script tries to set here and sends
 * its own UA string instead. This was verified directly, not assumed: a real Chromium
 * request (Playwright, 2026-09-04) with this exact header set below showed
 * `user-agent: Mozilla/5.0 (Macintosh; ...) Chrome/152...` on the wire, not the string
 * below. Setting it anyway is not dead code — it is a no-op in every browser today, costs
 * nothing, and is exactly right if this module is ever imported from a non-browser
 * runtime (a test, a future CLI tool) where the restriction does not apply.
 *
 * The header a browser *does* let through unmodified is `Referer`, sent automatically
 * from the page's own URL — also not something a script can set directly, but something a
 * script can accidentally suppress with a strict `Referrer-Policy`. Neither this file nor
 * `src/app.html` sets one, so the browser default (`strict-origin-when-cross-origin`)
 * applies; the same Playwright check showed a same-scheme cross-origin request carries the
 * full page URL (`referer: https://example.com/`), not just the origin. Once this app is
 * deployed at a real domain, that automatic Referer is the contact signal Transitous's
 * terms actually ask for in a browser context. Do not add a `Referrer-Policy` meta tag or
 * a `referrerPolicy: 'no-referrer'` fetch option without re-reading this comment.
 */

import type { Coordinates } from '../../domain';
import type { ProviderId } from '../types';
import { TRANSITOUS_NUM_ITINERARIES } from './transitous-mapper';
import type { TransitousPlanResponse } from './transitous-types';

/** Keyless and unmetered — no `../budget` cap or wiring applies — but still a real
 * registered adapter id, so it is checked against `ProviderId` (../types.ts, issue #69)
 * like every other adapter's id. */
export const TRANSITOUS_PROVIDER_ID: ProviderId = 'transitous';

/** Exported so a second Transitous-backed adapter (geocode/transitous-client.ts, issue
 * #64) hits the same host through the same constant instead of re-typing the URL. */
export const BASE_URL = 'https://api.transitous.org/api/v1';

/** See the file header — kept as a real value (not removed) so intent survives even
 * though no browser today sends it. */
export const TRANSITOUS_USER_AGENT = 'flights.mauri.app/0.1 (https://github.com/mauriciabad/flights)';

/**
 * Issue #220: what this adapter asks MOTIS to route with, and the reason it names modes at
 * all instead of taking the default.
 *
 * The default is `TRANSIT`, and MOTIS's own openapi.yaml defines that as
 * `TRAM,FERRY,AIRPLANE,BUS,COACH,RAIL,ODM,RIDE_SHARING,FUNICULAR,AERIAL_LIFT,OTHER`. The
 * list below is that definition with `AIRPLANE` removed and nothing else changed, so this
 * is not a hand-picked subset of public transport. It is the server's own idea of transit,
 * minus the one mode a ground transfer cannot contain.
 *
 * It has to be spelled out because MOTIS has no "everything except" form; a mode list is
 * the only way to say it. That has one real cost: a transit mode added to `TRANSIT` later
 * would not be asked for here until someone updates this list. The alternative cost is
 * worse. Asked for the 9.7 km from Birmingham airport to a Birmingham hostel at 03:00,
 * Transitous with `AIRPLANE` in play answers with four flights to Sardinia, Rome, Cagliari
 * and Amsterdam and a train and coach back, 21h 27m door to door; with this list it answers
 * with nothing, which is the truth (measured 2026-09-05, both ways).
 *
 * Verified against the live server on 2026-09-05, not assumed: every name here is accepted,
 * an unknown one is a hard `500` carrying `enum ModeEnum: unknown value ...`, and Barcelona
 * airport to Plaça Catalunya returns the identical six bus itineraries with this list as it
 * does with the default. `transitous-mapper.ts` drops an air leg again on the way in, since
 * a parameter this file sends is a request and not a guarantee.
 */
export const GROUND_TRANSIT_MODES = [
	'TRAM',
	'FERRY',
	'BUS',
	'COACH',
	'RAIL',
	'ODM',
	'RIDE_SHARING',
	'FUNICULAR',
	'AERIAL_LIFT',
	'OTHER'
] as const;

export interface TransitousPlanRequest {
	from: Coordinates;
	to: Coordinates;
	/** A UTC instant, not a `LocalDateTime` — this file only ever talks in the wire
	 * format. Converting a caller's local departure time into this belongs to
	 * transitous.ts, which has the airport's zone to do it with. */
	departureUtc: Date;
	/** Issue #135: MOTIS's own `arriveBy`. `true` makes `time` a deadline to arrive by,
	 * which is what a leg ending at an airport check-in needs; the answers then come back
	 * as the departures that still make it, latest first in usefulness. */
	arriveBy: boolean;
}

/** Thrown for any non-2xx HTTP response. `retryAfterSeconds` is only ever set for a 429,
 * carrying the `Retry-After` header when Transitous sends one, for issue #22's backoff. */
export class TransitousHttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterSeconds: number | undefined,
		message: string
	) {
		super(message);
		this.name = 'TransitousHttpError';
	}
}

/** Thrown when a 2xx response's body isn't JSON, or doesn't have the shape this adapter
 * reads — an upstream schema change, not a connectivity problem, so kept distinct from a
 * network failure (types.ts: "the fix is different... retrying it will not help"). */
export class TransitousMalformedResponseError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'TransitousMalformedResponseError';
	}
}

export interface FetchTransitousPlanOptions {
	signal: AbortSignal;
	/** Overrides the global `fetch`, for tests only. */
	fetchImpl?: typeof fetch;
}

/**
 * Fetches one page of itineraries for a specific instant. Resolves with the parsed body
 * on any 2xx response with the expected shape; throws `TransitousHttpError` or
 * `TransitousMalformedResponseError` otherwise, or lets `fetch`'s own `AbortError` /
 * network `TypeError` propagate unchanged so the caller's existing error taxonomy
 * (types.ts `ProviderError`) can classify those the same way it would for any adapter.
 */
export async function fetchTransitousPlan(
	request: TransitousPlanRequest,
	options: FetchTransitousPlanOptions
): Promise<TransitousPlanResponse> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(buildPlanUrl(request), {
		signal: options.signal,
		headers: { 'User-Agent': TRANSITOUS_USER_AGENT }
	});

	if (!response.ok) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
		const body = await safeReadText(response);
		throw new TransitousHttpError(
			response.status,
			retryAfterSeconds,
			`Transitous responded ${response.status}${body ? `: ${body}` : ''}`
		);
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch (cause) {
		throw new TransitousMalformedResponseError('Transitous returned a body that was not valid JSON', cause);
	}

	if (!isPlanResponseShape(json)) {
		throw new TransitousMalformedResponseError(
			'Transitous /plan response did not have the expected shape (missing "itineraries")'
		);
	}

	return json;
}

function buildPlanUrl(request: TransitousPlanRequest): string {
	const params = new URLSearchParams({
		fromPlace: `${request.from.latitude},${request.from.longitude}`,
		toPlace: `${request.to.latitude},${request.to.longitude}`,
		// Strips fetch/Date's milliseconds so the wire format matches what was verified
		// against the live API ("...T09:00:00Z", not "...T09:00:00.000Z"); Transitous was
		// never actually confirmed to reject the millisecond form, but there is no reason
		// to send more precision than a GTFS timetable (minute-granular) can use anyway.
		time: request.departureUtc.toISOString().replace(/\.\d{3}Z$/, 'Z'),
		numItineraries: String(TRANSITOUS_NUM_ITINERARIES),
		arriveBy: request.arriveBy ? 'true' : 'false',
		transitModes: GROUND_TRANSIT_MODES.join(',')
	});
	return `${BASE_URL}/plan?${params.toString()}`;
}

function isPlanResponseShape(value: unknown): value is TransitousPlanResponse {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { itineraries?: unknown }).itineraries)
	);
}

/** Exported alongside BASE_URL above for the same reason: a second Transitous adapter
 * reads a 429's Retry-After the same way this one does, not a re-derived copy. */
export function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) ? seconds : undefined;
}

export async function safeReadText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 200);
	} catch {
		return '';
	}
}

export interface TransitousHealthCheckOptions {
	signal: AbortSignal;
	fetchImpl?: typeof fetch;
}

/**
 * A cheap, keyless reachability probe: Transitous's geocoder answering a one-character
 * query, verified at ~0.25s against the live API. Deliberately not a `/plan` call — a
 * health check that itself costs a full itinerary search is the "NOT assumed cheap" case
 * ProviderBase.healthCheck warns callers about, and there is no reason to accept that cost
 * for a provider that needs no key to begin with.
 */
export async function checkTransitousHealth(options: TransitousHealthCheckOptions): Promise<void> {
	const doFetch = options.fetchImpl ?? fetch;
	const response = await doFetch(`${BASE_URL}/geocode?text=a`, {
		signal: options.signal,
		headers: { 'User-Agent': TRANSITOUS_USER_AGENT }
	});
	if (!response.ok) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
		throw new TransitousHttpError(response.status, retryAfterSeconds, `Transitous responded ${response.status}`);
	}
}
