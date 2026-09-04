/**
 * Bridges an adapter client that already resolves a `{ ok: true; data } | { ok: false;
 * error }` result — skyscanner-client.ts, agoda-client.ts and booking-client.ts all do this
 * — onto `callProviderWithBudget`'s "throw to signal failure" contract (./budget/
 * call-with-budget.ts, `CallProviderWithBudgetOptions.execute`), for use as its `execute`
 * callback.
 *
 * Issue #69: these three clients were each written to resolve rather than throw, unlike
 * flights-sky-client.ts and ryanair-client.ts, which is exactly what made wiring them
 * through the budget module (reserve-before-call, in-flight dedup, permanent
 * not-subscribed, 429 backoff) awkward enough that nobody had. Converting the client
 * itself to throw would touch three already-tested files and their fixtures; this one small
 * adapter does it at the call site instead, per AGENTS.md's "the budget call belongs at the
 * wrapper, not scattered through the client."
 *
 * `toProviderError` converts the client's own error shape into a real `ProviderError` —
 * pass the identity function when the client already resolves one (skyscanner-client.ts
 * does; agoda-client.ts and booking-client.ts each keep a bespoke
 * `{code:'rate-limited'|'http-error'|...}` union instead, translated by their own
 * `toProviderError`).
 *
 * `quota-exceeded`/`not-subscribed` are rethrown as a `ProviderHttpError` rather than the
 * generic `ClientResultError` below, so `defaultClassifyError` and `retryAfterSecondsOf`
 * (./budget/classify-error.ts) still recover the real HTTP status and `Retry-After` value —
 * `callProviderWithBudget`'s own error-building switch asks the classifier's error object
 * for exactly those two fields, not something `classifyClientResultError`'s `code` alone
 * can carry.
 */

import { ProviderHttpError, defaultClassifyError } from './budget';
import type { ProviderErrorCode } from './budget';
import type { ProviderError } from './types';

/** Carries a client's own already-classified `ProviderError` through `execute`'s
 * throw-to-fail contract, for every failure that isn't a `quota-exceeded`/`not-subscribed`
 * (those become a `ProviderHttpError` instead — see this file's header). */
export class ClientResultError extends Error {
	constructor(readonly providerError: ProviderError) {
		super(providerError.message);
		this.name = 'ClientResultError';
	}
}

/** Pass as `CallProviderWithBudgetOptions.classifyError`. Reads a `ClientResultError`'s own
 * code straight back off instead of re-deriving it from a generic message-pattern guess;
 * falls back to `defaultClassifyError` for a `ProviderHttpError` (already handles 429/403)
 * or anything else `execute` might throw. */
export function classifyClientResultError(error: unknown): ProviderErrorCode {
	if (error instanceof ClientResultError) return error.providerError.code;
	return defaultClassifyError(error);
}

/**
 * Awaits a client call and throws on failure instead of resolving an `{ ok: false }`, so it
 * can be handed to `callProviderWithBudget` as `execute`. Resolves the client's own `data`
 * on success, unchanged.
 */
export async function unwrapOrThrow<T, E>(
	resultPromise: Promise<{ ok: true; data: T } | { ok: false; error: E }>,
	toProviderError: (error: E) => ProviderError
): Promise<T> {
	const result = await resultPromise;
	if (result.ok) return result.data;

	const error = toProviderError(result.error);
	if (error.code === 'quota-exceeded') {
		throw new ProviderHttpError(429, error.message, error.retryAfterSeconds);
	}
	if (error.code === 'not-subscribed') {
		throw new ProviderHttpError(403, error.message);
	}
	throw new ClientResultError(error);
}
