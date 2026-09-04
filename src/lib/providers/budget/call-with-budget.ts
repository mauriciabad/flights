import { computeBackoffDelayMs, defaultSleep } from './backoff';
import type { BackoffOptions } from './backoff';
import { defaultClassifyError } from './classify-error';
import { dedupeInFlight } from './dedupe';
import { isPermanentlyUnsubscribed, markNotSubscribed } from './permanent-failures';
import { reserveProviderRequests } from './quota';
import type { ProviderCallOutcome, ProviderFailureKind, ProviderId } from './types';

export interface CallProviderWithBudgetOptions<T> {
	providerId: ProviderId;
	/** Requests one attempt spends. Default 1 — set higher for an adapter whose single call is inherently a batch of several provider requests. */
	cost?: number;
	/** Overrides the stored/default cap for this call. Mainly for tests. */
	cap?: number;
	/** Calls sharing a key while one is in flight share its outcome instead of firing twice. Build it from the provider id plus the query, e.g. the same key used for caching. */
	dedupeKey: string;
	/** Performs one real attempt. Throw to signal failure; `classifyError` decides what kind. */
	execute: () => Promise<T>;
	/** Defaults to `defaultClassifyError`. Override when an adapter already knows more about its own errors than a generic classifier can. */
	classifyError?: (error: unknown) => ProviderFailureKind;
	/** Total attempts allowed, the first one included. Default 3. */
	maxAttempts?: number;
	backoff?: BackoffOptions;
	/** Overrides the real timer-based delay. Tests pass an instant no-op so a retry test doesn't take 8 real seconds. */
	sleep?: (ms: number) => Promise<void>;
	/** Overrides `Date.now`. Mainly for tests. */
	now?: () => number;
}

const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set(['rate-limited', 'network-error', 'unknown']);

/**
 * The one function a provider adapter is expected to route every request
 * through. Ties together, in order: a permanent "not subscribed" short
 * circuit, in-flight deduplication, a hard quota stop before any fetch, and
 * exponential backoff on 429 — so an adapter's job shrinks to "how do I make
 * one HTTP call and turn the response into `T`", with the free-tier survival
 * logic living in exactly one place instead of copy-pasted into every
 * provider that needs it.
 */
export function callProviderWithBudget<T>(options: CallProviderWithBudgetOptions<T>): Promise<ProviderCallOutcome<T>> {
	return dedupeInFlight(options.dedupeKey, () => runWithBudget(options));
}

async function runWithBudget<T>(options: CallProviderWithBudgetOptions<T>): Promise<ProviderCallOutcome<T>> {
	const { providerId } = options;
	const cost = options.cost ?? 1;
	const classify = options.classifyError ?? defaultClassifyError;
	const maxAttempts = options.maxAttempts ?? 3;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;

	if (isPermanentlyUnsubscribed(providerId)) {
		return {
			ok: false,
			providerId,
			requestsUsed: 0,
			attempts: 0,
			error: {
				kind: 'not-subscribed',
				providerId,
				message: `${providerId} rejected an earlier call this session with "not subscribed" — retrying wastes a request on an answer that cannot change until the account is subscribed on RapidAPI.`
			}
		};
	}

	let attempts = 0;
	let requestsUsed = 0;

	for (;;) {
		const reservation = reserveProviderRequests(providerId, cost, { cap: options.cap, now });
		if (!reservation.ok) {
			return {
				ok: false,
				providerId,
				requestsUsed,
				attempts,
				error: {
					kind: 'quota-exceeded',
					providerId,
					message: `${providerId} is at ${reservation.used}/${reservation.cap} requests for ${reservation.monthKey}; refusing to spend ${cost} more rather than collect a 403.`,
					quota: { cap: reservation.cap, used: reservation.used, monthKey: reservation.monthKey }
				}
			};
		}

		attempts++;
		requestsUsed += cost;

		try {
			const value = await options.execute();
			return { ok: true, providerId, value, requestsUsed, attempts };
		} catch (rawError) {
			const kind = classify(rawError);

			if (kind === 'not-subscribed') {
				markNotSubscribed(providerId);
				return {
					ok: false,
					providerId,
					requestsUsed,
					attempts,
					error: { kind, providerId, message: describeError(rawError, `${providerId} is not subscribed to this API.`), cause: rawError }
				};
			}

			const canRetry = RETRYABLE.has(kind) && attempts < maxAttempts;
			if (!canRetry) {
				return {
					ok: false,
					providerId,
					requestsUsed,
					attempts,
					error: { kind, providerId, message: describeError(rawError, `${providerId} call failed.`), cause: rawError }
				};
			}

			await sleep(computeBackoffDelayMs(attempts, options.backoff));
			// Loop again: the next iteration reserves budget for the retry too,
			// so a retry storm still cannot spend past the cap.
		}
	}
}

function describeError(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}
