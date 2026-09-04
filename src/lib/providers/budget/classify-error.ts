import type { ProviderFailureKind } from './types';

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
		message: string
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
 * threw. Understands `ProviderHttpError`'s status code, the exact RapidAPI
 * "not subscribed" body even when it arrives as a plain thrown object, an
 * aborted `fetch`, and `fetch`'s own generic `TypeError` for a request that
 * never reached the network. Anything else classifies as `unknown` rather
 * than guessing, so the caller does not retry a failure it does not
 * understand.
 */
export function defaultClassifyError(error: unknown): ProviderFailureKind {
	if (error instanceof ProviderHttpError) {
		if (error.status === 429) return 'rate-limited';
		if (error.status === 403 && NOT_SUBSCRIBED_PATTERN.test(error.message)) return 'not-subscribed';
		return 'unknown';
	}

	// Checked by `.name` rather than `instanceof Error`/`DOMException`, since
	// which global a caught `AbortError` is an instance of has drifted across
	// JS environments — Node's own DOMException does extend Error, but that
	// is not guaranteed everywhere this code runs.
	if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';

	if (NOT_SUBSCRIBED_PATTERN.test(messageOf(error))) return 'not-subscribed';

	// `fetch` rejects with a `TypeError` ("Failed to fetch" / "Load failed")
	// when the request never reaches the network at all — offline, DNS
	// failure, or a CORS preflight rejection.
	if (error instanceof TypeError) return 'network-error';

	return 'unknown';
}
