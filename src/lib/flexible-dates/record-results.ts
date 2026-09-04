/**
 * Issue #71: the hook that makes "a year of cached prices" accumulate at all.
 *
 * Every search the app runs produces priced flights on real dates from real providers, and
 * until now every one of them was thrown away the moment the page unmounted. The response
 * cache keeps them, but keyed by a hash of the query, so nothing can ask it "what do we
 * have for BVC to LGW in March". This turns what a results page already has on screen into
 * ledger entries (`observations.ts`), at a cost of zero requests, and it is the only reason
 * this feature works for a route Ryanair does not fly.
 *
 * The extraction half is pure and tested; the recording half is one `void`-ed call the
 * results page makes as snapshots stream in.
 */

import type { CacheStore } from '../cache';
import type { IsoCurrencyCode } from '../domain';
import type { ItineraryGroup } from '../search';
import { recordLedgerFares } from './observations';
import type { LegKey } from './observations';
import type { DayFare } from './types';

/** One leg's worth of observations, ready to write. */
export interface LegObservation {
	leg: LegKey;
	fares: DayFare[];
}

/**
 * Every one-adult fare an itinerary group's variants carry, split by leg.
 *
 * `'party-total'` offers are skipped, deliberately and without a fallback: dividing a party
 * total by the traveller count is an average, and this ledger only holds fares. Skyscanner
 * is the adapter that shape belongs to (measured, `domain/flight-offer.ts`), so its results
 * simply do not feed the calendar. Saying that plainly beats a number nobody can book.
 *
 * `observedAt` comes from the offer's own `ProviderSource.fetchedAt`, the instant it came
 * off the provider's wire, which adapters are careful to preserve across a cache hit (#151)
 * Never from this function's clock.
 */
export function legObservationsFromGroup(
	group: ItineraryGroup,
	currency: IsoCurrencyCode
): LegObservation[] {
	const byLeg = new Map<string, LegObservation>();

	for (const variant of group.variants) {
		const itinerary = variant.score.itinerary;
		const legs = [
			{ offer: itinerary.outboundFlight, source: variant.sources.outboundFlight },
			{ offer: itinerary.onwardFlight, source: variant.sources.onwardFlight }
		];

		for (const { offer, source } of legs) {
			if (offer.priceScope !== 'per-person') continue;
			if (offer.price.currency !== currency) continue;
			const observedAt = Date.parse(source.fetchedAt);
			if (!Number.isFinite(observedAt)) continue;

			const leg: LegKey = {
				origin: offer.departureAirport,
				destination: offer.arrivalAirport,
				currency
			};
			const id = `${leg.origin}-${leg.destination}`;
			const entry = byLeg.get(id) ?? { leg, fares: [] };
			entry.fares.push({
				departureDate: offer.departure.local.slice(0, 10),
				arrivalDate: offer.arrival.local.slice(0, 10),
				minorUnits: offer.price.minorUnits,
				providerId: source.providerId,
				observedAt
			});
			byLeg.set(id, entry);
		}
	}

	// Cheapest per (date, provider) within this batch, so one group with twelve variants
	// writes one entry per day rather than twelve competing ones.
	for (const entry of byLeg.values()) {
		const best = new Map<string, DayFare>();
		for (const fare of entry.fares) {
			const id = `${fare.departureDate}|${fare.providerId}`;
			const existing = best.get(id);
			if (!existing || fare.minorUnits < existing.minorUnits) best.set(id, fare);
		}
		entry.fares = [...best.values()].sort((a, b) => a.departureDate.localeCompare(b.departureDate));
	}

	return [...byLeg.values()];
}

/**
 * Exactly what a group would contribute to the ledger, as one comparable string.
 *
 * This is the dedupe key, and it is deliberately the observations themselves rather than
 * anything about the group they came from. The search pipeline re-yields a stopover's group
 * every time anything about the search moves, and each write is a read-modify-write
 * transaction against the same IndexedDB store the search is reading from, so recording an
 * unchanged group is pure contention on an object store a traveller is waiting on. A first
 * attempt keyed this on the group's variant count and best total price instead, and that
 * was measurably wrong: a later, richer yield carrying a Kiwi fare hashed the same as the
 * Ryanair-only one before it and never reached the ledger.
 */
export function ledgerSignature(observations: readonly LegObservation[]): string {
	return observations
		.map(
			(observation) =>
				`${observation.leg.origin}>${observation.leg.destination}:${observation.leg.currency}=` +
				observation.fares
					.map((fare) => `${fare.departureDate}/${fare.providerId}/${fare.minorUnits}`)
					.join(',')
		)
		.sort()
		.join('|');
}

/**
 * Writes a group's fares to the ledger, skipping a group whose fares are already there.
 * Never rejects, see `recordLedgerFares`.
 *
 * `alreadyWritten` is the caller's own set rather than module state, so a page owns the
 * memo for as long as it is mounted and a test can hand in an empty one. Omitted, every
 * call writes.
 */
export async function recordItineraryGroup(
	group: ItineraryGroup,
	currency: IsoCurrencyCode,
	options: { alreadyWritten?: Set<string>; store?: CacheStore } = {}
): Promise<void> {
	const observations = legObservationsFromGroup(group, currency);
	if (observations.length === 0) return;

	if (options.alreadyWritten) {
		const signature = ledgerSignature(observations);
		if (options.alreadyWritten.has(signature)) return;
		options.alreadyWritten.add(signature);
	}

	for (const observation of observations) {
		await recordLedgerFares(observation.leg, observation.fares, { store: options.store });
	}
}
