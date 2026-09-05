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
import { currencyExponent, majorUnitsOf } from '$lib/domain';
import type { ItineraryScore } from '$lib/algorithm/score';
import { defaultStopoverLength, isFlightChange, stopoverLengths, stopoverOfLength } from '$lib/algorithm/stopover-length';
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
 * `retrievedAgeMs` is now on every tier, and that is the point. It used to sit only on
 * `expired-fallback`, so the other two answered "how old is this price" with a fact about
 * the search rather than a fact about the price, and `'fresh'` was rendered as the words
 * "Current price". Once #151 made adapters report a cached price's real age, a card could
 * show "Current price" beside "via Ryanair · fetched 58 minutes ago" — a hit at 59 minutes
 * is an ordinary outcome under ryanair.ts's one-hour fare TTL. Both lines are now derived
 * from this one number, so they cannot contradict each other.
 *
 * It is named for the clock it comes off, issue #170. Two instants exist here and they
 * are not interchangeable:
 *
 * - **when we retrieved it.** `ProviderSource.fetchedAt`, our clock, always known. This
 *   is what `retrievedAgeMs` measures, and the only one this app has.
 * - **when the provider last changed the price.** The provider's clock. A fare retrieved
 *   ten seconds ago may have been set eight hours ago, and that is the number a traveller
 *   is actually asking about.
 *
 * **No adapter in this app can supply the second one**, measured 2026-09-04 rather than
 * assumed — see the header of `providers/flights/ryanair-types.ts` for what Ryanair does
 * and does not send. So the honest thing is to say which clock this is and stop there:
 * the badge `view-model.ts` builds from this used to read "Priced 40 minutes ago", which
 * asserts a repricing instant nobody here has, off a number that only ever knew when our
 * own HTTP client last ran.
 *
 * The plain `ageMs` this replaced is what let that happen. Anyone can read an unqualified
 * "age" as the age of the thing rather than the age of our copy of it, which is how a
 * label claiming one got written over a number carrying the other.
 */
export type PriceFreshness =
	| { tier: 'fresh'; retrievedAgeMs: number }
	| { tier: 'stale'; retrievedAgeMs: number }
	| {
			tier: 'expired-fallback';
			retrievedAgeMs: number;
			reason: ProviderIssueReason;
			message: string;
	  };

/** One part of an itinerary and which provider supplied it, issue #23: "Show provenance:
 * which provider gave each price, and when it was fetched." An itinerary's total price is
 * rarely from one provider alone (a flight from one aggregator, a stay from another), so
 * this is a list rather than a single `{providerId, fetchedAt}` pair. */
export interface ProvenancePart {
	part: keyof ItinerarySources;
	providerId: ProviderId;
	providerLabel: string;
	/** Straight off `ProviderSource.fetchedAt`: when THIS APP retrieved the value. Never
	 * when the provider set it — see `PriceFreshness` above for why the difference is the
	 * whole of issue #170. */
	fetchedAt: string;
}

export interface ResultProvenance {
	/** Only the parts `ItinerarySources` actually has for this itinerary, a part with no
	 * tracked source (rare; `SourceTracker`'s own "best effort" attribution) is simply
	 * absent here, never a placeholder entry. */
	parts: ProvenancePart[];
	freshness: PriceFreshness;
}

/**
 * Issue #224: how long this stopover can be, and what the card is currently showing.
 *
 * The card opens at `minimum`, the fewest nights this connection city can be stopped over
 * in, and the traveller moves along `available` from there. Everything a nights control
 * needs to render and to explain itself is here, so `ResultCard` never reaches back into
 * the group's `variants` to work out what pressing + would do.
 */
/** One rung of a connection's ladder: a length it can do, and the trip at that length. */
export interface StopoverLengthOption {
	nights: number;
	/** The best-scoring pairing at this length. Carried rather than only its night count so
	 * a control can price a step BEFORE it is taken. A longer stay usually means a
	 * different onward fare, and "one more night, +EUR 41.00" on the button is the whole
	 * point of issue #224's "never silently". */
	itinerary: Itinerary;
}

export interface StopoverLengths {
	/** Every length this connection offers, ascending. Always contains the shown
	 * itinerary's own length, and always contains `minimum`. */
	options: StopoverLengthOption[];
	/** The count the card opens on, and the floor the traveller can return to. */
	minimum: number;
	/** The itinerary at `minimum`. What a longer pick's price and flights are compared
	 * against, so the card can say the price moved and why (issue #224: "Do not silently
	 * cap it either"). Identical to `ScoredResult.itinerary` while nothing is extended. */
	minimumItinerary: Itinerary;
	/**
	 * True when this city can be flown through on the same calendar day, which issue #225
	 * makes a flight change rather than a stopover:
	 *
	 * > there shoudl be no casa in wich the nights could be 0 or more, that case should
	 * > just be a flight change and thats it
	 *
	 * The card says so and offers no nights ladder. Longer pairings through the same city
	 * may still exist in `available`, and stay reachable through the flight picker, which
	 * is a deliberate choice of a specific flight rather than a night count counted up
	 * from zero.
	 */
	isFlightChange: boolean;
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
	/** How many pairings through this stopover share the shown itinerary's night count,
	 * brief line 67: "user can see alternative flights for same location... selecting
	 * updates ui." Exposed so a card can say "+2 more flight times" without the caller
	 * re-deriving it from the group itself.
	 *
	 * Issue #224 narrowed this from every variant to the ones at this length. Pairings at
	 * other lengths are a different offer, a different number of nights and a different
	 * total, and the nights control is what reaches them; counting them here would have
	 * promised "3 more flight times" and delivered three other trips. */
	variantCount: number;
	/** Issue #224: the stopover lengths this connection offers, and which one is shown. */
	stopover: StopoverLengths;
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
	// retrieved a minute ago and a bed retrieved an hour ago is an hour-old total.
	const retrievedAgeMs = oldestPartAgeMs(parts);

	const failingPart = parts.find((part) => providers[part.providerId]?.lastError !== undefined);
	if (failingPart) {
		const error = providers[failingPart.providerId]?.lastError as ProviderError;
		const { reason, message } = describeProviderError(error);
		return { parts, freshness: { tier: 'expired-fallback', retrievedAgeMs, reason, message } };
	}

	return {
		parts,
		freshness: done ? { tier: 'fresh', retrievedAgeMs } : { tier: 'stale', retrievedAgeMs }
	};
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
 *
 * `requestedNights` is issue #224's nights control: the length the traveller has chosen
 * for THIS stopover, if any. Omitted, or asking for a length this city cannot do, falls
 * back to `group.best`, the shortest one it can. Nothing here re-prices or re-fetches:
 * every length is a pairing this search already has in `variants`, so moving between them
 * costs no provider request at all.
 */
export function deriveScoredResult(
	group: ItineraryGroup,
	snapshot: Pick<SearchSnapshot, 'providers' | 'done'>,
	sequence: number,
	requestedNights?: number
): ScoredResult {
	const lengths = stopoverLengths(group.variants, (variant) => variant.score.itinerary.nightsInConnection);
	const minimum = defaultStopoverLength(lengths);
	const chosen =
		(requestedNights === undefined ? undefined : stopoverOfLength(lengths, requestedNights)) ?? minimum;
	// `group.variants` is never empty (a group exists because a variant put it there), so
	// both of the above resolve; `group.best` is the honest fallback if that ever changes.
	const shown = chosen?.pick ?? group.best;
	const minimumShown = minimum?.pick ?? group.best;

	return {
		id: group.connectionAirportCode,
		sequence,
		itinerary: shown.score.itinerary,
		score: shown.score,
		variantCount: chosen?.count ?? 1,
		stopover: {
			options: lengths.map((length) => ({
				nights: length.nights,
				itinerary: length.pick.score.itinerary
			})),
			minimum: minimumShown.score.itinerary.nightsInConnection,
			minimumItinerary: minimumShown.score.itinerary,
			isFlightChange: isFlightChange(lengths)
		},
		price: buildProvenance(shown.sources, snapshot.providers, snapshot.done)
	};
}

/** The connection airport code an Itinerary touches, mirrors
 * `ItineraryGroup.connectionAirportCode` for callers that only have the `Itinerary` itself
 * (e.g. `ResultCard`, which reads `result.itinerary` rather than the group it came from). */
export function connectionAirportCode(itinerary: Itinerary): IataAirportCode {
	return itinerary.outboundFlight.arrivalAirport;
}

/** Total price in major units (e.g. euros, not cents), for filter thresholds a person
 * types in. Scaled by the currency's own exponent (`majorUnitsOf`, domain/money.ts): a
 * "max ¥20000" typed into a filter has to mean twenty thousand yen and not two hundred,
 * which is what dividing every currency by 100 gave (issue #179). */
export function priceMajorUnits(price: Money): number {
	return majorUnitsOf(price);
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

/** As much of one grouped widen row as this month's remaining allowance can pay for. */
export interface AffordableWiden {
	/** The stopovers that fit, in the group's own ranking order (best candidate first, the
	 * order `widenSearch` and `widenWithPriceCalendar` process targets in). */
	options: WidenOption[];
	/** What `options` costs. Never above `remaining`. */
	requests: number;
	/** Stopovers left out because the allowance ran out. Zero when the whole row fits. */
	skipped: number;
}

/**
 * Issue #244: the panel used to ask "does the whole bundle fit" and disable the row when it
 * did not. On the acceptance search that bundle was every stopover at once, so a single
 * number over the cap took the whole action away, and the Sky Scrapper key the owner
 * configured was unreachable from any search. A row nobody can press is worse than no row,
 * because it reads as the provider being broken.
 *
 * So the question becomes "how much of this fits", and the answer is a prefix rather than
 * all-or-nothing. Both widen calls already take many candidates behind one shared ceiling
 * and stop when it runs out (`widenSearch`'s `budget.remaining`), so spending a prefix is
 * the behaviour they already have, not a new one — this only makes the panel say up front
 * what it would have discovered halfway through.
 *
 * A prefix, not the cheapest subset: the group's order is the free tier's own candidate
 * ranking, so the first N are the N stopovers most worth paying to confirm. Picking a
 * cheaper tail instead would spend the month on worse answers.
 */
export function affordableWidenOptions(group: WidenOptionGroup, remaining: number): AffordableWiden {
	const options: WidenOption[] = [];
	let requests = 0;
	for (const option of group.options) {
		if (requests + option.requests > remaining) break;
		options.push(option);
		requests += option.requests;
	}
	return { options, requests, skipped: group.options.length - options.length };
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
	// `majorUnitsOf` rather than `/ 100`: this line is read while debugging a wrong price,
	// so it must not be the one place that reports one (issue #179).
	const amount = majorUnitsOf(cheapest.price).toFixed(currencyExponent(cheapest.price.currency));
	return `${legLabel} calendar for ${outcome.candidateAirportCode}: cheapest is ${cheapest.date} at ${amount} ${cheapest.price.currency} (${cheapest.group}).`;
}
