export interface BackoffOptions {
	/** Delay before the first retry, in ms. Default 500. */
	baseDelayMs?: number;
	/** Never wait longer than this, however many attempts have failed. Default 8000. */
	maxDelayMs?: number;
	/** Injectable so a test can assert an exact delay instead of a range. Defaults to `Math.random`. */
	random?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 500;
/** Exported so a caller honouring a provider's own `Retry-After` hint can still cap it — a search the user is watching should not freeze for however long a provider asks. */
export const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * Delay before retry attempt N (1-indexed: `attempt` is the number of the
 * attempt that just failed). Doubles each time, capped at `maxDelayMs`, with
 * "equal jitter" — half the delay is fixed, half is randomised — so a fleet
 * of tabs retrying the same 429 at once do not all retry on the same tick
 * and immediately trip the rate limit again.
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
	const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const random = options.random ?? Math.random;

	const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
	const half = exponential / 2;
	return Math.round(half + random() * half);
}

/** Real `setTimeout`-based delay. Tests inject their own no-op or instant `sleep` instead of waiting for real time to pass. */
export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
