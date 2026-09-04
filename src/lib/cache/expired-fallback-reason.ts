/**
 * Why a refetch failed, attached to the `expired-fallback` tier of
 * `StaleWhileRevalidateResult` (issue #35). A plain `unknown` error would let
 * a component print "something went wrong" for every case; this union forces
 * it to at least consider quota exhaustion, an unsubscribed key, offline and
 * a generic network failure separately, since a user can act on the first
 * two (buy a plan, wait for the reset) but not the rest.
 *
 * Deliberately not `ProviderError` from `src/lib/providers/types.ts`, even
 * though the codes overlap on purpose. That type belongs to a different
 * issue and describes what one adapter's `Promise` resolves to
 * (`ProviderResult`, never a rejection); this cache works with any
 * `fetcher: () => Promise<T>`, so it cannot assume every rejection is a
 * `ProviderError`. `classifyExpiredFallbackReason` recognises that shape
 * structurally when it sees it, without the cache module depending on the
 * providers module to compile.
 */
export type ExpiredFallbackReason =
	| { code: 'quota-exceeded'; message: string }
	| { code: 'not-subscribed'; message: string }
	| { code: 'offline'; message: string }
	| { code: 'network-error'; message: string }
	| { code: 'unknown'; message: string };

const KNOWN_REASON_CODES = new Set<ExpiredFallbackReason['code']>([
	'quota-exceeded',
	'not-subscribed',
	'network-error'
]);

type KnownReasonCode = 'quota-exceeded' | 'not-subscribed' | 'network-error';

function hasKnownReasonCode(
	error: unknown
): error is { code: KnownReasonCode; message?: unknown } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof (error as { code: unknown }).code === 'string' &&
		KNOWN_REASON_CODES.has((error as { code: KnownReasonCode }).code)
	);
}

function defaultMessageFor(code: KnownReasonCode): string {
	switch (code) {
		case 'quota-exceeded':
			return "This provider's request quota is used up for now.";
		case 'not-subscribed':
			return 'This provider is not set up with a working key.';
		case 'network-error':
			return 'The request to the provider failed.';
	}
}

/**
 * Classifies a failed refetch for display, from whatever the fetcher's
 * promise rejected with. Checks the browser's own online state first and
 * independently of the error's shape: a `fetch()` made while offline can
 * reject with anything from a generic `TypeError` to a provider-shaped
 * network error, but "you are offline" is a more useful and more certain
 * answer than any of those messages, and it is the one case this module can
 * verify itself rather than infer from the error.
 */
export function classifyExpiredFallbackReason(error: unknown): ExpiredFallbackReason {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) {
		return { code: 'offline', message: 'The browser is offline.' };
	}

	if (hasKnownReasonCode(error)) {
		const message = typeof error.message === 'string' ? error.message : defaultMessageFor(error.code);
		return { code: error.code, message };
	}

	return {
		code: 'unknown',
		message: error instanceof Error ? error.message : String(error)
	};
}
