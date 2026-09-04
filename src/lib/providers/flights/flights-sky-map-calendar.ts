import type { IsoCurrencyCode } from '../../domain';
import { moneyFromMajorUnits } from '../../domain';
import type { PriceCalendarDay, PriceCalendarGroup } from './flights-sky-types';

/** Thrown when `price-calendar`'s response is missing `data.flights.days` entirely — a
 * schema change, not a normal per-day gap. The caller (flights-sky.ts) turns this into a
 * `malformed-response` for that one call rather than letting it propagate uncaught. */
export class FlightsSkyMalformedCalendarResponseError extends Error {}

const KNOWN_GROUPS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function isPriceCalendarGroup(value: unknown): value is PriceCalendarGroup {
	return typeof value === 'string' && KNOWN_GROUPS.has(value);
}

/**
 * Turns one `price-calendar` response into `PriceCalendarDay[]`, one entry per day the API
 * priced. Measured 2026-09-04 against a real BCN-VIE call: 366 contiguous days, no gaps,
 * running from *today* through exactly one year forward — see
 * fixtures/flights-sky-price-calendar-bcn-vie.json and this issue's PR description for the
 * full evidence. Nothing here assumes that count or that range; a day missing a usable price
 * or an unrecognised `group` value is dropped rather than guessed at (AGENTS.md: "say what
 * you do not know rather than guessing"), so a future response with real gaps in it degrades
 * to fewer days, not a thrown error or a fabricated price.
 */
export function mapPriceCalendarDays(raw: unknown, currency: IsoCurrencyCode): PriceCalendarDay[] {
	const entries = extractDayEntries(raw);
	const days: PriceCalendarDay[] = [];
	for (const entry of entries) {
		const day = mapDayEntry(entry, currency);
		if (day !== undefined) days.push(day);
	}
	return days;
}

function extractDayEntries(raw: unknown): unknown[] {
	if (isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.flights) && Array.isArray(raw.data.flights.days)) {
		return raw.data.flights.days;
	}
	throw new FlightsSkyMalformedCalendarResponseError(
		'Flights Sky price-calendar response did not have a data.flights.days array'
	);
}

function mapDayEntry(entry: unknown, currency: IsoCurrencyCode): PriceCalendarDay | undefined {
	if (!isRecord(entry)) return undefined;
	const date = asIsoDate(entry.day);
	if (date === undefined) return undefined;
	if (!isPriceCalendarGroup(entry.group)) return undefined;
	const price = moneyFromMajorUnits(entry.price, currency);
	if (price === undefined) return undefined;
	return { date, group: entry.group, price };
}

// "2026-09-15", not a fuller ISO instant — a loose but cheap check, since this field only
// ever needs to round-trip as an `IsoCalendarDate` (a plain string alias, ../../domain).
function asIsoDate(value: unknown): string | undefined {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}
