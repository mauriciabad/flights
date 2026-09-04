import type { ProviderErrorCode } from './types';

/**
 * A marker an adapter can throw from its `execute` function when it already
 * knows the HTTP status, so classification matches on a status code instead
 * of guessing from a message string. Not required — `defaultClassifyError`
 * still does its best with a bare `Error` — but preferred whenever the
 * status is known, since a status code cannot be phrased differently by a
 * future API response the way prose can.
 */
export class ProviderHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** Parsed from a `Retry-After` header, when the provider sent one on a 429. Carried through to `ProviderError`'s `quota-exceeded.retryAfterSeconds` (../types.ts) instead of a guessed backoff. */
		readonly retryAfterSeconds?: number
	) {
		super(message);
		this.name = 'ProviderHttpError';
	}
}

// The exact body RapidAPI returns for an API the account has no plan for,
// per docs/PROVIDERS.md: `{"message":"You are not subscribed to this API."}`.
const NOT_SUBSCRIBED_PATTERN = /not subscribed/i;

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'object' && error !== null && 'message' in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return '';
}

/**
 * Best-effort classification for whatever an adapter's `execute` function
 * threw, mapped onto the exact codes `../types.ts` defines rather than a
 * parallel vocabulary — a 429 becomes `quota-exceeded`, the same code an
 * upstream request already exhausted this session's own budget carries,
 * since both mean "spending more right now is not possible." Understands
 * `ProviderHttpError`'s status code, the exact RapidAPI "not subscribed"
 * body even when it arrives as a plain thrown object, a JSON parse failure,
 * an aborted `fetch`, and `fetch`'s own generic `TypeError` for a request
 * that never reached the network. Anything else classifies as `unknown`
 * rather than guessing, so the caller does not retry a failure it does not
 * understand.
 */
export function defaultClassifyError(error: unknown): ProviderErrorCode {
	if (error instanceof ProviderHttpError) {
		if (error.status === 429) return 'quota-exceeded';
		if (error.status === 403 && NOT_SUBSCRIBED_PATTERN.test(error.message)) return 'not-subscribed';
		return 'unknown';
	}

	// Checked by `.name` rather than `instanceof Error`/`DOMException`, since
	// which global a caught `AbortError` is an instance of has drifted across
	// JS environments — Node's own DOMException does extend Error, but that
	// is not guaranteed everywhere this code runs.
	if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';

	if (NOT_SUBSCRIBED_PATTERN.test(messageOf(error))) return 'not-subscribed';

	// A response that parses as neither valid JSON nor whatever shape the
	// adapter expected — a schema change or an HTML error page under a 2xx —
	// is an upstream contract problem, not a connectivity one. Retrying it
	// would not help, which is why it is its own code rather than folded
	// into `unknown` or `network-error`.
	if (error instanceof SyntaxError) return 'malformed-response';

	// `fetch` rejects with a `TypeError` ("Failed to fetch" / "Load failed")
	// when the request never reaches the network at all — offline, DNS
	// failure, or a CORS preflight rejection.
	if (error instanceof TypeError) return 'network-error';

	return 'unknown';
}

/** Pulls a `Retry-After` hint out of a thrown error, when the adapter supplied one via `ProviderHttpError`. */
export function retryAfterSecondsOf(error: unknown): number | undefined {
	if (error instanceof ProviderHttpError && typeof error.retryAfterSeconds === 'number') {
		return error.retryAfterSeconds;
	}
	return undefined;
}
