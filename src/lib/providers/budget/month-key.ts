/**
 * Calendar month in UTC, e.g. "2026-09". RapidAPI's monthly quota resets on a
 * calendar-month boundary; keying on UTC rather than the browser's local zone
 * means every traveller's counter resets at the same real instant regardless
 * of where they are, instead of drifting with whatever midnight their device
 * thinks it is.
 */
export function monthKeyFor(now: number | Date = Date.now()): string {
	const date = typeof now === 'number' ? new Date(now) : now;
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `${year}-${month}`;
}

/**
 * How long until the calendar month rolls over — what a locally-refused
 * `quota-exceeded` result reports as `retryAfterSeconds` (../types.ts), since
 * "come back next month" is the honest answer once our own counter is spent,
 * the same way a `Retry-After` header is the honest answer to an upstream
 * 429. `Date.UTC` handles the December-into-January wraparound on its own.
 */
export function secondsUntilNextMonthUtc(now: number | Date = Date.now()): number {
	const date = typeof now === 'number' ? new Date(now) : now;
	const nextMonthStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
	return Math.max(0, Math.round((nextMonthStartMs - date.getTime()) / 1000));
}
