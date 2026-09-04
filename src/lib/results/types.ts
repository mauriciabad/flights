/**
 * Issue #23 (results list): the shapes this feature renders, built directly from the real
 * search pipeline (issue #56, `$lib/search`), merged before this PR opened, so this module
 * consumes its actual `SearchSnapshot`/`ItineraryGroup`/`ProviderStatus` types rather than a
 * guessed interface.
 *
 * The pipeline's own `types.ts` deliberately does not track per-value cache freshness, its
 * adapters cache-aside directly against `CacheStore` rather than through
 * `staleWhileRevalidate` (see e.g. `providers/flights/ryanair.ts`'s "why not
 * staleWhileRevalidate" comment, which explicitly leaves the two-phase stale/fresh
 * distinction to "a future UI layer"). That UI layer is this one: `deriveScoredResult`
 * below reconstructs a fresh/stale/expired-fallback reading for each itinerary from what
 * the pipeline DOES expose, `ItinerarySources` (which provider, fetched when) and
 * `ProviderStatus.lastError` (that provider's most recent failure, if any), rather than
 * inventing a field the pipeline was never going to carry.
 */

import type { IataAirlineCode, IataAirportCode, Itinerary, Money } from '$lib/domain';
import type { ItineraryScore } from '$lib/algorithm/score';
import type { ProviderError, ProviderId } from '$lib/providers/types';
import type { ProviderIssueReason } from '$lib/components';
import type {
	ItineraryGroup,
	ItinerarySources,
	PriceCalendarOutcome,
	ProviderStatus,
	SearchSnapshot,
	WidenOption
} from '$lib/search';

export type { ItineraryGroup, ProviderStatus, SearchSnapshot, WidenOption } from '$lib/search';

/**
 * How trustworthy an itinerary's headline price is right now, reconstructed for display
 * (see this file's header for why the pipeline itself doesn't carry this):
 *
 * - `'fresh'`: the search has finished (`SearchSnapshot.done`) and every provider behind
 *   this price answered without error. Safe to show as a plain, current number.
 * - `'stale'`: the search is still running. This price is real (it came from an actual
 *   provider response, never a guess), but a later snapshot could still refine it.
 *   AGENTS.md's "never present an estimate as a fact" is answered by marking it, not by
 *   hiding the number.
 * - `'expired-fallback'`: at least one provider behind this price has a CURRENT failure
 *   (`ProviderStatus.lastError`). The number shown is the last one that provider actually
 *   returned, not a live figure, `ageMs` and `reason` are required, mirroring
 *   `cache/stale-while-revalidate.ts`'s own `ExpiredFallbackResult` for the identical
 *   reason: a component cannot read `.value` here without also having the caveat in scope.
 */
export type PriceFreshness =
	| { tier: 'fresh' }
	| { tier: 'stale' }
	| { tier: 'expired-fallback'; ageMs: number; reason: ProviderIssueReason; message: string };

/** One part of an itinerary and which provider supplied it, issue #23: "Show provenance:
 * which provider gave each price, and when it was fetched." An itinerary's total price is
 * rarely from one provider alone (a flight from one aggregator, a stay from another), so
 * this is a list rather than a single `{providerId, fetchedAt}` pair. */
export interface ProvenancePart {
	part: keyof ItinerarySources;
	providerId: ProviderId;
	providerLabel: string;
	fetchedAt: string;
}

export interface ResultProvenance {
	/** Only the parts `ItinerarySources` actually has for this itinerary, a part with no
	 * tracked source (rare; `SourceTracker`'s own "best effort" attribution) is simply
	 * absent here, never a placeholder entry. */
	parts: ProvenancePart[];
	freshness: PriceFreshness;
}

/** One stopover, ready to render and order: `ItineraryGroup.best` plus its provenance.
 * `algorithm/score.ts` never filters, only ranks, an avoided-airline group is always
 * present here, exactly as it is in `ItineraryGroup`. */
export interface ScoredResult {
	/** = `ItineraryGroup.connectionAirportCode`, already the pipeline's own stable
	 * per-stopover key, `stream-order.ts` uses this to update a card's content across
	 * snapshots without ever moving its position (see that module's header). */
	id: IataAirportCode;
	/** First-seen order across this whole search's snapshots, assigned once by whoever
	 * calls `deriveScoredResult` (`+page.svelte`), used only as sort.ts's deterministic
	 * last-resort tie-break, never shown to the user. */
	sequence: number;
	itinerary: Itinerary;
	score: ItineraryScore;
	/** `ItineraryGroup.variants.length`, brief line 67: "user can see alternative
	 * flights for same location... selecting updates ui." Exposed so a card can say "+2
	 * more flight times" without the caller re-deriving it from the group itself. */
	variantCount: number;
	price: ResultProvenance;
}

/** Maps the pipeline's real error taxonomy onto the vocabulary `ErrorState.svelte`
 * already renders everywhere else in this app (provider status strip included), so a
 * quota failure reads identically whether it surfaces on a price badge or a provider
 * pill. Not a 1:1 rename: `network-error` reads as "the provider is not responding" to a
 * traveller ('down'`) more usefully than a literal translation of the code would. */
export function describeProviderError(error: ProviderError): { reason: ProviderIssueReason; message: string } {
	switch (error.code) {
		case 'missing-key':
			return { reason: 'missing-key', message: error.message };
		case 'not-subscribed':
			return { reason: 'not-subscribed', message: error.message };
		case 'quota-exceeded':
			return { reason: 'quota-exceeded', message: error.message };
		case 'network-error':
			return { reason: 'down', message: error.message };
		case 'malformed-response':
		case 'cancelled':
		case 'unknown':
			return { reason: 'unknown', message: error.message };
	}
}

const SOURCE_PARTS = [
	'outboundFlight',
	'onwardFlight',
	'stay',
	'transferToHotel',
	'transferToConnectionAirport',
	'transferToOriginAirport',
	'transferToDestinationLocation'
] as const satisfies readonly (keyof ItinerarySources)[];

function buildProvenance(
	sources: ItinerarySources,
	providers: Record<ProviderId, ProviderStatus>,
	done: boolean
): ResultProvenance {
	const parts: ProvenancePart[] = [];
	for (const part of SOURCE_PARTS) {
		const source = sources[part];
		if (!source) continue;
		const providerLabel = providers[source.providerId]?.label ?? source.providerId;
		parts.push({ part, providerId: source.providerId, providerLabel, fetchedAt: source.fetchedAt });
	}

	const failingPart = parts.find((part) => providers[part.providerId]?.lastError !== undefined);
	if (failingPart) {
		const error = providers[failingPart.providerId]?.lastError as ProviderError;
		const { reason, message } = describeProviderError(error);
		const oldestFetchedAtMs = Math.min(...parts.map((part) => new Date(part.fetchedAt).getTime()));
		return {
			parts,
			freshness: { tier: 'expired-fallback', ageMs: Math.max(0, Date.now() - oldestFetchedAtMs), reason, message }
		};
	}

	return { parts, freshness: done ? { tier: 'fresh' } : { tier: 'stale' } };
}

/**
 * Builds one `ScoredResult` from a snapshot's `ItineraryGroup`. Pure given `sequence`:
 * the caller (`+page.svelte`) owns assigning that once per connection code across the
 * whole search's lifetime, the same "first-seen order, never recomputed" rule
 * `stream-order.ts` needs to keep ties stable.
 */
export function deriveScoredResult(
	group: ItineraryGroup,
	snapshot: Pick<SearchSnapshot, 'providers' | 'done'>,
	sequence: number
): ScoredResult {
	return {
		id: group.connectionAirportCode,
		sequence,
		itinerary: group.best.score.itinerary,
		score: group.best.score,
		variantCount: group.variants.length,
		price: buildProvenance(group.best.sources, snapshot.providers, snapshot.done)
	};
}

/** The connection airport code an Itinerary touches, mirrors
 * `ItineraryGroup.connectionAirportCode` for callers that only have the `Itinerary` itself
 * (e.g. `ResultCard`, which reads `result.itinerary` rather than the group it came from). */
export function connectionAirportCode(itinerary: Itinerary): IataAirportCode {
	return itinerary.outboundFlight.arrivalAirport;
}

/** Total price in major units (e.g. euros, not cents), for filter thresholds a person
 * types in. Exact for EUR/USD/GBP, wrong by a factor of 100 for a zero-decimal currency,
 * the same documented trade-off as `algorithm/score.ts`'s own `priceInMajorUnits`. */
export function priceMajorUnits(price: Money): number {
	return price.minorUnits / 100;
}

/** Airline codes the traveller asked to avoid, threaded through from
 * `SearchQuery.airlinesToAvoid` to wherever a filter/sort helper needs it without
 * re-importing the whole query. */
export type AvoidedAirlines = readonly IataAirlineCode[];

/** Identifies one `WidenOption` uniquely for the lifetime of a search, shared between
 * `+page.svelte` (tracking which one is in flight) and `WidenOptionsPanel.svelte`
 * (matching that key back to its own button) so the two never drift into two different
 * ideas of "the same option." */
export function widenOptionKey(option: WidenOption): string {
	return `${option.providerId}:${option.tier}:${option.candidateAirportCode ?? 'all'}`;
}

/**
 * One line describing what a price-calendar widen found, issue #56's tier 2, "which
 * dates are cheap." Deliberately not rendered through `ResultCard`: a calendar answers a
 * different question than a priced itinerary does, so this stays its own small summary
 * rather than being forced into a shape built for the other question.
 */
export function summarizePriceCalendarOutcome(outcome: PriceCalendarOutcome): string {
	const legLabel = outcome.leg === 'outbound' ? 'Outbound' : 'Onward';
	if (!outcome.result.ok) {
		const { message } = describeProviderError(outcome.result.error);
		return `${legLabel} calendar for ${outcome.candidateAirportCode}: ${message}`;
	}
	const days = outcome.result.data;
	if (days.length === 0) {
		return `${legLabel} calendar for ${outcome.candidateAirportCode}: no prices returned.`;
	}
	const cheapest = days.reduce((min, day) => (day.price.minorUnits < min.price.minorUnits ? day : min));
	return `${legLabel} calendar for ${outcome.candidateAirportCode}: cheapest is ${cheapest.date} at ${(cheapest.price.minorUnits / 100).toFixed(2)} ${cheapest.price.currency} (${cheapest.group}).`;
}
