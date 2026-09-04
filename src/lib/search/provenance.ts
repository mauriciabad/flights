/**
 * Tracks "which provider produced this value, and when" without changing the domain types
 * (`FlightOffer`, `Stay`, `Transfer`) that carry no provenance field of their own — issue
 * #56: "carry, per result, which provider produced each number and how old it is."
 *
 * `buildItineraries` (algorithm/build.ts) passes through the exact object references it is
 * given — an `Itinerary.outboundFlight` is the very same `FlightOffer` instance a provider
 * adapter returned, never a copy. That makes a `WeakMap` keyed by object identity a reliable
 * way to look provenance back up after the fact: tag every offer/stay/transfer the moment it
 * comes off a provider call (`attach`), then after `buildItineraries` runs, `sourceFor` each
 * field of the resulting `Itinerary` to reconstruct an `ItinerarySources` (see
 * `pipeline.ts`'s `sourcesForItinerary`). `WeakMap` rather than a plain `Map` so tagged
 * values are still garbage-collectable once a search's results are replaced by a later one.
 */

import type { AnyProvider, ProviderId, ProviderKind, ProviderResult, ProviderSource } from '../providers/types';
import type { ProviderStatus } from './types';

export class SourceTracker {
	#sources = new WeakMap<object, ProviderSource>();

	/** Tags `value` with where it came from and returns it unchanged, so a call site can
	 * write `sources.attach(offer, result.source)` inline in a `.map()`/`for` loop. */
	attach<T extends object>(value: T, source: ProviderSource): T {
		this.#sources.set(value, source);
		return value;
	}

	sourceFor(value: object | undefined): ProviderSource | undefined {
		return value === undefined ? undefined : this.#sources.get(value);
	}
}

/**
 * Folds one `ProviderResult` into the running per-provider status a `SearchSnapshot`
 * reports. Mutates `status` in place (a plain `Map`, not exposed outside `pipeline.ts`) —
 * every provider call this pipeline makes should funnel through this one function so
 * `requestsUsed` stays an accurate running total and a later success clears an earlier
 * failure (see `ProviderStatus.lastError`'s own doc comment for why that clearing matters).
 */
export function recordProviderResult<T>(
	status: Map<ProviderId, ProviderStatus>,
	provider: Pick<AnyProvider, 'id' | 'kind' | 'label'>,
	result: ProviderResult<T>
): void {
	const previous = status.get(provider.id);
	const requestsUsed = (previous?.requestsUsed ?? 0) + result.requestsUsed;
	status.set(provider.id, {
		providerId: provider.id,
		kind: provider.kind as ProviderKind,
		label: provider.label,
		requestsUsed,
		lastError: result.ok ? undefined : result.error,
		lastFetchedAt: result.ok ? result.source.fetchedAt : previous?.lastFetchedAt
	});
}

/** Signature every helper in `resources.ts`/`providers-adapter.ts` uses to report a
 * provider call back to the pipeline's status map, without those modules needing to know the
 * map's own shape — they just call `record(provider, result)`. */
export type RecordProviderCall = <T>(
	provider: Pick<AnyProvider, 'id' | 'kind' | 'label'>,
	result: ProviderResult<T>
) => void;
