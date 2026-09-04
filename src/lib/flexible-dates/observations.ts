/**
 * Issue #71: the ledger of prices this app has actually seen.
 *
 * The Ryanair month grid (`ryanair-month-grid.ts`) can fill a year for a route Ryanair
 * flies, keylessly. For every other route, including the owner's own BVC to PFO, which
 * Ryanair does not serve at all, the only prices this app will ever hold are the ones it
 * already fetched while somebody was searching. Those live in the response cache keyed by a
 * hash of the exact query that produced them (`cache/key.ts`), which makes them unreadable
 * by anyone who does not already know the question: you cannot enumerate "every fare we
 * have for BVC to LGW" out of a hash.
 *
 * So results get written down as they stream past, in one place, in a shape that can be
 * asked "what do we know about October". One entry per leg-month, in the same IndexedDB
 * store as everything else, so `indexedDB.deleteDatabase('flights-cache')` still clears the
 * whole app and the same LRU size cap still applies.
 *
 * Three rules this file exists to keep:
 *
 * - **One adult, or nothing.** A `'party-total'` fare (Skyscanner's shape, measured, see
 *   `domain/flight-offer.ts`) is dropped rather than divided by the traveller count. That
 *   division produces an average, not a fare, and a made-up number ranking a week cheapest
 *   is the exact failure this feature must not have.
 * - **Newest wins per source, cheapest wins across sources.** A fresher observation from
 *   the same provider replaces the older one even when it is dearer, because a price is a
 *   fact at a time and keeping the flattering half of the history is lying.
 * - **Nothing is ever inferred.** A day with no entry is unknown, not expensive.
 */

import { defineCacheKey, getDefaultStore, readCachedEntry } from '../cache';
import type { CacheStore } from '../cache';
import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../domain';
import { monthStartOf } from './calendar';
import type { DayFare } from './types';

/** Namespace for this ledger's cache entries. Not a `ProviderId`: nothing here came from
 * one provider, and `CacheStore.deleteByProvider` is meant to drop one adapter's data. */
export const LEDGER_NAMESPACE = 'flexible-dates';

/** How long an entry survives eviction pressure. Reads deliberately ignore this (see
 * `readLedgerMonths`), so it only governs the LRU bookkeeping `CacheStore` does. */
const LEDGER_TTL_MS = 180 * 24 * 60 * 60_000;

/**
 * How old an observation may be and still count towards a ranking.
 *
 * Thirty days is a judgement, and it is the conservative direction: a two-month-old fare is
 * evidence about a season, not about a price, and letting one win a week would put a number
 * on screen that nobody can book. Entries older than this stay on disk (they cost nothing
 * and a future widening of this window can use them); they are simply not ranked.
 */
export const DEFAULT_MAX_OBSERVATION_AGE_MS = 30 * 24 * 60 * 60_000;

/** The route and currency one ledger entry is about. A leg, not a trip. */
export interface LegKey {
	origin: IataAirportCode;
	destination: IataAirportCode;
	currency: IsoCurrencyCode;
}

interface StoredFare {
	providerId: string;
	arrivalDate: IsoCalendarDate;
	minorUnits: number;
	observedAt: number;
}

interface StoredLedgerMonth {
	/** Bumped if the shape ever changes. An entry with an unrecognised version is ignored
	 * rather than coerced. #131's lesson, applied before it can bite: a cached value whose
	 * shape changed must not be served back as if it were the new shape. */
	version: 1;
	days: Record<IsoCalendarDate, StoredFare[]>;
}

/** At most this many sources per day. There are five flight adapters in the registry, so
 * this is a ceiling nothing reaches in practice. It exists so a future adapter churn
 * cannot grow one day's entry without bound. */
const MAX_SOURCES_PER_DAY = 8;

/** Exported for tests, which need to plant a deliberately wrong value under a real key to
 * prove an unrecognised shape is ignored rather than coerced (#131's lesson). */
export function ledgerCacheKey(leg: LegKey, monthStart: IsoCalendarDate) {
	return defineCacheKey(
		LEDGER_NAMESPACE,
		{
			op: 'dayFares',
			origin: leg.origin,
			destination: leg.destination,
			currency: leg.currency,
			monthStart
		},
		LEDGER_TTL_MS
	);
}

function isStoredMonth(value: unknown): value is StoredLedgerMonth {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as StoredLedgerMonth).version === 1 &&
		typeof (value as StoredLedgerMonth).days === 'object' &&
		(value as StoredLedgerMonth).days !== null
	);
}

async function resolveStore(store?: CacheStore): Promise<CacheStore> {
	return store ?? (await getDefaultStore());
}

function estimateSizeBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Everything the ledger holds for these months, newer than `maxAgeMs`, one `DayFare` per
 * (date, provider). Reading never touches the network and never fails a caller: a
 * malformed or missing entry is simply no data.
 */
export async function readLedgerMonths(
	leg: LegKey,
	monthStarts: readonly IsoCalendarDate[],
	options: { store?: CacheStore; now?: number; maxAgeMs?: number } = {}
): Promise<DayFare[]> {
	const store = await resolveStore(options.store);
	const now = options.now ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS;

	const fares: DayFare[] = [];
	for (const monthStart of monthStarts) {
		// Deliberately `readCachedEntry`, which never discards on expiry: an entry's own TTL
		// is the LRU's business, and how old an observation is is `maxAgeMs`'s, below.
		const entry = await readCachedEntry<unknown>(store, ledgerCacheKey(leg, monthStart));
		if (!entry || !isStoredMonth(entry.value)) continue;
		for (const [departureDate, stored] of Object.entries(entry.value.days)) {
			if (!Array.isArray(stored)) continue;
			for (const fare of stored) {
				if (typeof fare?.minorUnits !== 'number' || typeof fare?.observedAt !== 'number') continue;
				if (now - fare.observedAt > maxAgeMs) continue;
				fares.push({
					departureDate,
					arrivalDate: fare.arrivalDate ?? departureDate,
					minorUnits: fare.minorUnits,
					providerId: fare.providerId ?? 'unknown',
					observedAt: fare.observedAt
				});
			}
		}
	}
	return fares;
}

/**
 * Writes observations down, merging with what is already there.
 *
 * Never throws: this runs alongside a results page that has already rendered, and a full
 * disk or a private-browsing quota error must not take a working search down with it. A
 * failed write means the next search records it again.
 */
export async function recordLedgerFares(
	leg: LegKey,
	fares: readonly DayFare[],
	options: { store?: CacheStore } = {}
): Promise<void> {
	if (fares.length === 0) return;
	try {
		const store = await resolveStore(options.store);

		const byMonth = new Map<IsoCalendarDate, DayFare[]>();
		for (const fare of fares) {
			const monthStart = monthStartOf(fare.departureDate);
			const bucket = byMonth.get(monthStart);
			if (bucket) bucket.push(fare);
			else byMonth.set(monthStart, [fare]);
		}

		for (const [monthStart, monthFares] of byMonth) {
			const key = ledgerCacheKey(leg, monthStart);
			const existing = await readCachedEntry<unknown>(store, key);
			const days: Record<IsoCalendarDate, StoredFare[]> =
				existing && isStoredMonth(existing.value) ? { ...existing.value.days } : {};

			for (const fare of monthFares) {
				const day = [...(days[fare.departureDate] ?? [])];
				const at = day.findIndex((stored) => stored.providerId === fare.providerId);
				const next: StoredFare = {
					providerId: fare.providerId,
					arrivalDate: fare.arrivalDate,
					minorUnits: fare.minorUnits,
					observedAt: fare.observedAt
				};
				// Newest wins for a given source, even when it is dearer. Keeping the older,
				// cheaper number would make the ledger flatter than reality on purpose.
				if (at === -1) day.push(next);
				else if (day[at].observedAt <= fare.observedAt) day[at] = next;
				days[fare.departureDate] = day.slice(0, MAX_SOURCES_PER_DAY);
			}

			const value: StoredLedgerMonth = { version: 1, days };
			const now = Date.now();
			await store.set({
				key: key.raw,
				providerId: LEDGER_NAMESPACE,
				value,
				storedAt: now,
				ttlMs: key.ttlMs,
				lastAccessedAt: now,
				sizeBytes: estimateSizeBytes(value)
			});
		}
	} catch {
		// See the doc comment: a ledger write is bookkeeping for a later visit, never
		// something the current screen depends on.
	}
}
