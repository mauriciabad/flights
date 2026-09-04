import { DEFAULT_MAX_DELAY_MS, computeBackoffDelayMs, defaultSleep } from './backoff';
import type { BackoffOptions } from './backoff';
import { defaultClassifyError, retryAfterSecondsOf } from './classify-error';
import { dedupeInFlight } from './dedupe';
import { secondsUntilNextMonthUtc } from './month-key';
import { isPermanentlyUnsubscribed, markNotSubscribed } from './permanent-failures';
import { reserveProviderRequests } from './quota';
import type { ReserveResult } from './quota';
import type { ProviderError, ProviderErrorCode, ProviderId, ProviderResult } from './types';

export interface CallProviderWithBudgetOptions<T> {
	providerId: ProviderId;
	/** Requests one attempt spends. Default 1 — set higher for an adapter whose single call is inherently a batch of several provider requests. */
	cost?: number;
	/** Overrides the stored/default cap for this call. Mainly for tests. */
	cap?: number;
	/** Calls sharing a key while one is in flight share its outcome instead of firing twice. Build it from the provider id plus the query, e.g. the same key used for caching. */
	dedupeKey: string;
	/** Performs one real attempt and returns the adapter's `data`. Throw to signal failure — `classifyError` decides which `ProviderError` code it becomes. */
	execute: () => Promise<T>;
	/** Defaults to `defaultClassifyError`. Override when an adapter already knows more about its own errors than a generic classifier can. */
	classifyError?: (error: unknown) => ProviderErrorCode;
	/** Total attempts allowed, the first one included. Default 3. */
	maxAttempts?: number;
	backoff?: BackoffOptions;
	/** Overrides the real timer-based delay. Tests pass an instant no-op so a retry test doesn't take 8 real seconds. */
	sleep?: (ms: number) => Promise<void>;
	/** Overrides `Date.now`. Mainly for tests. */
	now?: () => number;
}

// `quota-exceeded` here only ever means an upstream 429 — a local pre-flight
// refusal (the cap already spent) returns immediately, before this set is
// consulted at all. `network-error` is worth one more try; `unknown` is
// deliberately NOT retried, because retrying a failure this layer does not
// understand risks spending the rest of the month's budget on repeats of the
// same mistake instead of surfacing it.
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['quota-exceeded', 'network-error']);

/**
 * The one function a provider adapter is expected to route every request
 * through, returning exactly the `ProviderResult<T>` (../types.ts) an
 * adapter method is contracted to resolve — so an adapter never hand-rolls
 * the conversion from "what actually happened" to "what the interface
 * promises callers." Ties together, in order: a permanent "not subscribed"
 * short circuit, in-flight deduplication, a hard quota stop before any
 * fetch, and exponential backoff on a 429 (re-checking quota before every
 * retry, so a retry storm cannot itself exceed the cap).
 *
 * Adapter usage:
 * ```ts
 * async searchOffers(query, ctx) {
 *   return callProviderWithBudget({
 *     providerId: this.id,
 *     dedupeKey: `${this.id}:searchOffers:${JSON.stringify(query)}`,
 *     execute: () => fetchOffers(query, ctx) // throws ProviderHttpError, or lets fetch's own errors through
 *   });
 * }
 * ```
 */
export function callProviderWithBudget<T>(
	options: CallProviderWithBudgetOptions<T>
): Promise<ProviderResult<T>> {
	return dedupeInFlight(options.dedupeKey, () => runWithBudget(options));
}

async function runWithBudget<T>(options: CallProviderWithBudgetOptions<T>): Promise<ProviderResult<T>> {
	const { providerId } = options;
	const cost = options.cost ?? 1;
	const classify = options.classifyError ?? defaultClassifyError;
	const maxAttempts = options.maxAttempts ?? 3;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const maxDelayMs = options.backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const source = () => ({ providerId, fetchedAt: new Date(now()).toISOString() });

	if (isPermanentlyUnsubscribed(providerId)) {
		return {
			ok: false,
			requestsUsed: 0,
			source: source(),
			error: {
				code: 'not-subscribed',
				status: 403,
				message: `${providerId} rejected an earlier call this session with "not subscribed" — retrying wastes a request on an answer that cannot change until the account is subscribed on RapidAPI.`
			}
		};
	}

	let requestsUsed = 0;

	for (let attempt = 1; ; attempt++) {
		const reservation = reserveProviderRequests(providerId, cost, { cap: options.cap, now });
		if (!reservation.ok) {
			return {
				ok: false,
				requestsUsed,
				source: source(),
				error: {
					code: 'quota-exceeded',
					status: 429,
					message: describeRefusal(providerId, cost, reservation),
					retryAfterSeconds: secondsUntilNextMonthUtc(now())
				}
			};
		}

		requestsUsed += cost;

		try {
			const data = await options.execute();
			return { ok: true, data, requestsUsed, source: source() };
		} catch (rawError) {
			const code = classify(rawError);

			if (code === 'not-subscribed') markNotSubscribed(providerId);

			const retryAfterSeconds = retryAfterSecondsOf(rawError);
			// Issue #124/#157: confirmed live that a bare 429 is not always the short
			// per-minute limit this loop was built to ride out. Flights Sky's real account,
			// once its 50-a-month tier was actually exhausted, answered "You have exceeded
			// the MONTHLY quota" — also a 429, also classified `quota-exceeded`, and this
			// loop retried it three times on a guessed few-second backoff before giving up,
			// spending requests an account with zero left could not afford. A per-minute
			// limit and a monthly one are indistinguishable from the status code alone, but
			// only the former comes with a `Retry-After` header short enough for a caller to
			// usefully sleep through (confirmed against the real 429 body: a monthly
			// exhaustion carries none). So `quota-exceeded` only retries when the provider
			// itself said how long to wait; no header means "not on any timeline this loop
			// could sleep through," same treatment as `unknown`. `network-error` is
			// unaffected — it was never gated on a header to begin with.
			const canRetry =
				attempt < maxAttempts &&
				(code === 'network-error' || (code === 'quota-exceeded' && retryAfterSeconds !== undefined)) &&
				RETRYABLE.has(code);
			if (!canRetry) {
				return { ok: false, requestsUsed, source: source(), error: toProviderError(code, rawError, providerId) };
			}

			const delayMs =
				retryAfterSeconds !== undefined
					? Math.min(retryAfterSeconds * 1000, maxDelayMs)
					: computeBackoffDelayMs(attempt, options.backoff);
			await sleep(delayMs);
			// Loop again: the next iteration reserves budget for the retry too.
		}
	}
}

/**
 * Names the limit that actually refused this call. AGENTS.md: show the answer you got.
 * "This app's own cap is spent" and "the provider says the key has nothing left" call for
 * different responses from the person reading it — the first can be raised in settings,
 * the second cannot be argued with — and reporting both as the same sentence is how the
 * settings screen came to claim "0 of 40 spent" about a month that was 85% gone (#146).
 */
function describeRefusal(providerId: ProviderId, cost: number, reservation: ReserveResult): string {
	if (reservation.refusal === 'provider-reported-empty' && reservation.reported !== undefined) {
		const { remaining, limit, observedAt } = reservation.reported;
		const plan = limit === undefined ? '' : ` of ${limit}`;
		return `${providerId} itself reported ${remaining}${plan} requests left on this key, as of ${new Date(observedAt).toISOString()}; refusing to spend ${cost} more.`;
	}
	return `${providerId} is at ${reservation.used}/${reservation.cap} requests for ${reservation.monthKey}; refusing to spend ${cost} more rather than collect a 403.`;
}

/** Builds the exact `ProviderError` shape (../types.ts) each code requires — a discriminated union whose members carry different fields, so this cannot be one shared object literal. */
function toProviderError(code: ProviderErrorCode, rawError: unknown, providerId: ProviderId): ProviderError {
	const message = describeError(rawError, `${providerId} call failed.`);
	switch (code) {
		case 'missing-key':
			return { code, message };
		case 'not-subscribed':
			return { code, message, status: 403 };
		case 'quota-exceeded':
			return { code, message, status: 429, retryAfterSeconds: retryAfterSecondsOf(rawError) };
		case 'network-error':
			return { code, message, cause: rawError };
		case 'malformed-response':
			return { code, message, cause: rawError };
		case 'cancelled':
			return { code, message };
		case 'unknown':
			return { code, message, cause: rawError };
	}
}

function describeError(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}
