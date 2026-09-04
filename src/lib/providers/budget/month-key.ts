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
