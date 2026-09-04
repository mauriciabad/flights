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
 * Whether an ok `ProviderResult` actually carried anything. Every payload this pipeline
 * records is a list (offers, route codes, stays, transfers), so "carried nothing" is
 * exactly an empty array; a non-array payload counts as data, since there is no length to
 * read and inventing one would be a guess.
 */
function carriesData(data: unknown): boolean {
	if (Array.isArray(data)) return data.length > 0;
	return data !== undefined && data !== null;
}

/**
 * Folds one `ProviderResult` into the running per-provider status a `SearchSnapshot`
 * reports. Mutates `status` in place (a plain `Map`, not exposed outside `pipeline.ts`) —
 * every provider call this pipeline makes should funnel through this one function so
 * `requestsUsed` stays an accurate running total and a later success clears an earlier
 * failure (see `ProviderStatus.lastError`'s own doc comment for why that clearing matters).
 *
 * Issue #130 added the two `okCalls*` counters: cumulative rather than last-write-wins,
 * because "Ryanair answered twice and knew nothing either time" is the fact the results
 * page has to state, and a single boolean overwritten by the next call cannot hold it.
 */
export function recordProviderResult<T>(
	status: Map<ProviderId, ProviderStatus>,
	provider: Pick<AnyProvider, 'id' | 'kind' | 'label'>,
	result: ProviderResult<T>
): void {
	const previous = status.get(provider.id);
	const requestsUsed = (previous?.requestsUsed ?? 0) + result.requestsUsed;
	const hasData = result.ok && carriesData(result.data);
	status.set(provider.id, {
		providerId: provider.id,
		kind: provider.kind as ProviderKind,
		label: provider.label,
		requestsUsed,
		lastError: result.ok ? undefined : result.error,
		lastFetchedAt: result.ok ? result.source.fetchedAt : previous?.lastFetchedAt,
		okCalls: (previous?.okCalls ?? 0) + (result.ok ? 1 : 0),
		okCallsWithData: (previous?.okCallsWithData ?? 0) + (hasData ? 1 : 0)
	});
}

/**
 * Issue #130: the four states a provider can be in during one search, as a UI has to tell
 * them apart. The bug this replaces was a results panel that could only render "answered"
 * or nothing at all, so a Ryanair `404` for an airport outside its network — an ok, empty,
 * genuinely useful answer — rendered as "Nothing has answered yet."
 *
 * - `'answered'`: at least one ok call carried rows.
 * - `'nothing-found'`: every ok call came back empty. The provider was asked, it replied,
 *   and it has nothing for this query. Never a failure, and never the same thing as silence.
 * - `'failed'`: this provider's most recent call did not succeed (`lastError`). Takes
 *   precedence over the counters above, matching `lastError`'s own "cleared on a later
 *   success" contract: what is true now is what a traveller is told.
 * - `'not-asked'`: recorded with no resolved call at all. `SearchSnapshot.providers` has no
 *   entry for a provider in this state today, so it exists for a caller that builds a row
 *   per registered adapter rather than per adapter called.
 */
export type ProviderAnswer = 'answered' | 'nothing-found' | 'failed' | 'not-asked';

export function providerAnswer(status: Pick<ProviderStatus, 'lastError' | 'okCalls' | 'okCallsWithData'>): ProviderAnswer {
	if (status.lastError) return 'failed';
	if (status.okCallsWithData > 0) return 'answered';
	if (status.okCalls > 0) return 'nothing-found';
	return 'not-asked';
}

/** Signature every helper in `resources.ts`/`providers-adapter.ts` uses to report a
 * provider call back to the pipeline's status map, without those modules needing to know the
 * map's own shape — they just call `record(provider, result)`. */
export type RecordProviderCall = <T>(
	provider: Pick<AnyProvider, 'id' | 'kind' | 'label'>,
	result: ProviderResult<T>
) => void;
