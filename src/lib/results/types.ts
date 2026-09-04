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
import type { ProviderError, ProviderId, ProviderKind } from '$lib/providers/types';
import type { ProviderIssueReason } from '$lib/components';
import type {
	ItineraryGroup,
	ItinerarySources,
	PriceCalendarOutcome,
	ProviderStatus,
	SearchSnapshot,
	WidenOption,
	WidenTier
} from '$lib/search';

export type { ItineraryGroup, ProviderStatus, SearchSnapshot, WidenOption } from '$lib/search';

/**
 * How trustworthy an itinerary's headline price is right now, reconstructed for display
 * (see this file's header for why the pipeline itself doesn't carry this):
 *
 * - `'fresh'`: the search has finished (`SearchSnapshot.done`) and every provider behind
 *   this price answered without error.
 * - `'stale'`: the search is still running. This price is real (it came from an actual
 *   provider response, never a guess), but a later snapshot could still refine it.
 *   AGENTS.md's "never present an estimate as a fact" is answered by marking it, not by
 *   hiding the number.
 * - `'expired-fallback'`: at least one provider behind this price has a CURRENT failure
 *   (`ProviderStatus.lastError`). The number shown is the last one that provider actually
 *   returned, not a live figure, `reason` is required, mirroring
 *   `cache/stale-while-revalidate.ts`'s own `ExpiredFallbackResult` for the identical
 *   reason: a component cannot read `.value` here without also having the caveat in scope.
 *
 * `ageMs` is now on every tier, and that is the point. It used to sit only on
 * `expired-fallback`, so the other two answered "how old is this price" with a fact about
 * the search rather than a fact about the price, and `'fresh'` was rendered as the words
 * "Current price". Once #151 made adapters report a cached price's real age, a card could
 * show "Current price" beside "via Ryanair · fetched 58 minutes ago" — a hit at 59 minutes
 * is an ordinary outcome under ryanair.ts's one-hour fare TTL. Both lines are now derived
 * from this one number, so they cannot contradict each other.
 */
export type PriceFreshness =
	| { tier: 'fresh'; ageMs: number }
	| { tier: 'stale'; ageMs: number }
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
	providers: Partial<Record<ProviderId, ProviderStatus>>,
	done: boolean
): ResultProvenance {
	const parts: ProvenancePart[] = [];
	for (const part of SOURCE_PARTS) {
		const source = sources[part];
		if (!source) continue;
		const providerLabel = providers[source.providerId]?.label ?? source.providerId;
		parts.push({ part, providerId: source.providerId, providerLabel, fetchedAt: source.fetchedAt });
	}

	// The oldest contributing part decides, on every tier: a total assembled from a flight
	// priced a minute ago and a bed priced an hour ago is an hour-old total.
	const ageMs = oldestPartAgeMs(parts);

	const failingPart = parts.find((part) => providers[part.providerId]?.lastError !== undefined);
	if (failingPart) {
		const error = providers[failingPart.providerId]?.lastError as ProviderError;
		const { reason, message } = describeProviderError(error);
		return { parts, freshness: { tier: 'expired-fallback', ageMs, reason, message } };
	}

	return { parts, freshness: done ? { tier: 'fresh', ageMs } : { tier: 'stale', ageMs } };
}

/** Zero when there is nothing to age, which is the honest answer for an itinerary whose
 * parts carry no tracked source at all — `Math.min` of an empty list is `Infinity`, and an
 * infinitely old price is a worse lie than a brand new one. */
function oldestPartAgeMs(parts: readonly ProvenancePart[]): number {
	if (parts.length === 0) return 0;
	const oldestFetchedAtMs = Math.min(...parts.map((part) => new Date(part.fetchedAt).getTime()));
	return Math.max(0, Date.now() - oldestFetchedAtMs);
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
 * Issue #96: `pipeline.ts` computes one `WidenOption` per connection candidate per
 * provider, which is right for `widenSearch`'s own bookkeeping but wrong to render
 * one-for-one. A traveller decides "spend N requests on Skyscanner" once, not once per
 * stopover city the panel never even names. This is that one row: every underlying
 * per-candidate option for the same provider and tier, folded together with their costs
 * summed, so "the total is the number a person actually decides on" (the issue's own
 * words) is the number shown.
 */
export interface WidenOptionGroup {
	providerId: ProviderId;
	kind: ProviderKind;
	tier: WidenTier;
	label: string;
	/** Sum of every underlying option's `requests`, what committing to this one row would
	 * spend across every candidate it covers, in one `widenSearch`/`widenWithPriceCalendar`
	 * call (both already accept many candidates sharing one budget ceiling). */
	requests: number;
	/** Identical across every option folded into this group: it depends only on whether
	 * `providerId` has a usable key, never on which candidate, so reading it off the first
	 * underlying option is exact, not a guess. */
	requiresKey: boolean;
	/** The per-candidate options this group summarises. A caller building a real
	 * `WidenRequest`/`candidateAirportCodes` list widens every one of these at once, rather
	 * than the traveller picking a single stopover the panel never showed them anyway. */
	options: WidenOption[];
}

/** Groups `WidenOption`s by provider and tier, summing their cost. Cheapest group first,
 * same tie-break as `estimatePriceCalendarWidenCost`'s own sort, so the panel's row order
 * doesn't reshuffle for reasons a traveller can't see. */
export function groupWidenOptions(options: readonly WidenOption[]): WidenOptionGroup[] {
	const groups = new Map<string, WidenOptionGroup>();
	for (const option of options) {
		const key = widenOptionGroupKey(option);
		const existing = groups.get(key);
		if (existing) {
			existing.requests += option.requests;
			existing.options.push(option);
		} else {
			groups.set(key, {
				providerId: option.providerId,
				kind: option.kind,
				tier: option.tier,
				label: option.label,
				requests: option.requests,
				requiresKey: option.requiresKey,
				options: [option]
			});
		}
	}
	return [...groups.values()].sort((a, b) => a.requests - b.requests || a.providerId.localeCompare(b.providerId));
}

/** Identifies one `WidenOptionGroup` for the lifetime of a search, the same role
 * `widenOptionKey` plays for a single candidate's option, one level up now that a panel
 * row is a provider+tier pair rather than a provider+tier+candidate triple. Also accepts a
 * plain `WidenOption`, since a group's key is exactly what its underlying options share. */
export function widenOptionGroupKey(option: Pick<WidenOption, 'providerId' | 'tier'>): string {
	return `${option.providerId}:${option.tier}`;
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
