/**
 * Issue #130: what the results page is allowed to say when a finished search has no
 * itineraries.
 *
 * The copy this replaces was "None of the free providers above found a workable connection
 * for this search. Widen the search above, or try a different destination." On the owner's
 * own BVC -> PFO route that sentence was an invented conclusion: Ryanair had answered twice,
 * both times `404` (its way of saying an airport is not on its network at all), and no
 * amount of widening dates could ever change that. AGENTS.md, on the Agoda incident that
 * cost the same kind of time: "we should show the actual errors recieved, not invent our
 * own." So every sentence this module produces is derived from a `ProviderStatus` the
 * pipeline actually recorded, and a provider's own failure message is passed through
 * verbatim rather than summarised.
 *
 * Pure and Svelte-free on purpose: the wording is the part most likely to be wrong, and a
 * plain function is the part a test can pin down (`no-results.test.ts`). The component
 * (`NoResultsBoard.svelte`) only lays out what comes back from here.
 *
 * Deliberately independent of which providers are in the free tier today. Issue #124 moves
 * the Flights Sky calendar into the default path, which changes who answers and who is
 * merely available, and none of that changes this module: it reads the recorded answers and
 * the registry's own "needs a key, has none" list at runtime. There will always be routes no
 * free source covers, which is exactly when this screen is shown.
 */

import type { ProviderId } from '$lib/providers/types';
import { providerAnswer } from '$lib/search';
import type { ProviderAnswer, ProviderStatus } from '$lib/search';
import { SETTINGS_PROVIDERS } from '$lib/settings/provider-catalog';
import { describeProviderError } from './types';

/** One airport as this screen names it: "Boa Vista (BVC)" when the dataset resolved a name,
 * bare "BVC" when it did not. Never a guessed name. */
export interface NamedAirport {
	code: string;
	name?: string;
}

/** A flight adapter the registry knows about, reduced to what this module needs. The results
 * page builds these from `registry.ofKind('flight')` plus `isProviderUsable`, so a provider
 * added later shows up here the day it registers. */
export interface RegisteredFlightProvider {
	id: ProviderId;
	label: string;
	needsKey: boolean;
	/** `isProviderUsable(provider, keys)`: a key is present for every field it declares. */
	usable: boolean;
}

/** One line on the board: which source, what it actually said, and what it cost. */
export interface FlightSourceLine {
	providerId: ProviderId;
	label: string;
	answer: ProviderAnswer;
	requestsUsed: number;
	/** Short, past tense, and true of this search only. */
	verdict: string;
	/** The provider's own message, present only when it failed. Passed through untouched. */
	rawError?: string;
}

/** The one keyed provider worth suggesting, chosen by its own free-tier size rather than by
 * name, so this never has to be edited when the provider mix changes. */
export interface KeyGapFix {
	providerId: ProviderId;
	label: string;
	/** Free-tier requests per month, from `settings/provider-catalog.ts`'s measured table. */
	monthlyQuota: number;
	/** Anchors straight at that provider's own settings card (`ProviderKeyCard` renders
	 * `id={provider.id}`). */
	href: string;
	/** Button label, e.g. "Add a Flights Sky key". */
	actionLabel: string;
}

/**
 * Which of the three genuinely different endings this search reached:
 *
 * - `'direct-route'`: a free source confirmed a direct origin-to-destination flight, so a
 *   stopover simply is not the better answer (issue #107's case, kept as it was).
 * - `'no-route-known'`: no stopover candidate survived at all. Nothing about dates, prices or
 *   filters was ever reached — the route graph itself is empty here. The BVC case.
 * - `'no-priced-pairing'`: stopovers existed and were priced, and no pair of flights came
 *   back that an itinerary could be built from.
 */
export type NoResultsCause = 'direct-route' | 'no-route-known' | 'no-priced-pairing';

export interface NoResultsExplanation {
	cause: NoResultsCause;
	title: string;
	/** One sentence about what happened. Says nothing the `sources` below do not support. */
	detail: string;
	/** Every flight source this search actually called, in recorded order. Empty only for a
	 * search that made no flight call at all. */
	sources: FlightSourceLine[];
	/** Absent when every registered flight provider already has a key, or when the ones
	 * missing keys have no settings row to send anyone to. */
	fix?: KeyGapFix;
}

export interface NoResultsInput {
	origin: NamedAirport;
	destination: NamedAirport;
	/** Every provider status the final snapshot carried, any kind — filtered to flights here
	 * so the caller does not have to know which kinds matter. */
	providers: readonly ProviderStatus[];
	/** Every registered flight adapter and whether it is usable right now. */
	registeredFlightProviders: readonly RegisteredFlightProvider[];
	/** `SearchSnapshot.candidates.length` on the final snapshot. Zero is what separates "no
	 * route at all" from "routes existed, no fare pairing worked". */
	candidateCount: number;
	/** `SearchSnapshot.hasDirectRoute`, meaningful only on that same final snapshot. */
	hasDirectRoute: boolean;
}

/** "Boa Vista (BVC)", or "BVC" when the airport dataset has not resolved a name. */
export function airportLabel(airport: NamedAirport): string {
	return airport.name ? `${airport.name} (${airport.code})` : airport.code;
}

function verdictFor(status: ProviderStatus, answer: ProviderAnswer, origin: NamedAirport, routeGraphOnly: boolean): string {
	switch (answer) {
		case 'failed':
			return 'could not answer';
		case 'nothing-found':
			// A search that never got past candidate discovery only ever asked this provider
			// one kind of question ("what flies out of here"), so naming the origin is exact.
			// Once fares were fetched it asked several, and "nothing at all" is all that is
			// jointly true of the answers.
			return routeGraphOnly ? `no routes from ${origin.code}` : 'answered with nothing';
		case 'answered':
			return routeGraphOnly ? 'answered with routes' : 'answered with flights';
		case 'not-asked':
			return 'not asked yet';
	}
}

/** Provider message and status code together, the pairing AGENTS.md calls out by name:
 * "`403` versus `200`-with-an-error-body is exactly the distinction that went missing here." */
function rawErrorFor(status: ProviderStatus): string | undefined {
	if (!status.lastError) return undefined;
	const { message } = describeProviderError(status.lastError);
	const httpStatus = 'status' in status.lastError ? status.lastError.status : undefined;
	return httpStatus === undefined ? message : `${httpStatus}: ${message}`;
}

/** One line per flight provider this search called, in the order the pipeline recorded them. */
export function flightSourceLines(
	providers: readonly ProviderStatus[],
	origin: NamedAirport,
	routeGraphOnly: boolean
): FlightSourceLine[] {
	return providers
		.filter((status) => status.kind === 'flight')
		.map((status) => {
			const answer = providerAnswer(status);
			return {
				providerId: status.providerId,
				label: status.label,
				answer,
				requestsUsed: status.requestsUsed,
				verdict: verdictFor(status, answer, origin, routeGraphOnly),
				rawError: rawErrorFor(status)
			};
		});
}

/**
 * The keyed flight provider with the largest free tier among those still missing a key.
 * Largest tier rather than a name, for the same reason `providers/budget/caps.ts`'s
 * `isQuotaGenerous` reads the live cap instead of listing providers: whoever has the most
 * room is the suggestion that actually fixes the gap, and that stays true as the provider
 * mix changes. A provider with no settings row is skipped — there is nowhere to send anyone
 * to paste a key for it, so suggesting it would be advice nobody can act on.
 */
export function pickKeyGapFix(registered: readonly RegisteredFlightProvider[]): KeyGapFix | undefined {
	const candidates = registered
		.filter((provider) => provider.needsKey && !provider.usable)
		.map((provider) => {
			const descriptor = SETTINGS_PROVIDERS.find((entry) => entry.id === provider.id);
			return descriptor ? { provider, descriptor } : undefined;
		})
		.filter((entry): entry is { provider: RegisteredFlightProvider; descriptor: (typeof SETTINGS_PROVIDERS)[number] } => entry !== undefined)
		.sort(
			(a, b) => b.descriptor.monthlyQuota - a.descriptor.monthlyQuota || a.provider.id.localeCompare(b.provider.id)
		);

	const best = candidates[0];
	if (!best) return undefined;
	return {
		providerId: best.provider.id,
		label: best.descriptor.label,
		monthlyQuota: best.descriptor.monthlyQuota,
		href: `/settings/#${best.provider.id}`,
		actionLabel: `Add a ${best.descriptor.label} key`
	};
}

function joinLabels(labels: string[]): string {
	if (labels.length <= 1) return labels[0] ?? '';
	return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Builds the whole explanation. Every branch below states only what `input` records. */
export function explainNoResults(input: NoResultsInput): NoResultsExplanation {
	const { origin, destination, candidateCount, hasDirectRoute } = input;
	const routeGraphOnly = candidateCount === 0;
	const sources = flightSourceLines(input.providers, origin, routeGraphOnly);
	const fix = pickKeyGapFix(input.registeredFlightProviders);

	if (hasDirectRoute) {
		return {
			cause: 'direct-route',
			title: 'Well served direct',
			detail: `${airportLabel(origin)} to ${airportLabel(destination)} has a direct flight on the free sources, so no stopover here is worth turning into a trip. That is not a claim that nothing else flies, only that a detour is not the better answer this time.`,
			sources,
			fix: undefined
		};
	}

	if (candidateCount > 0) {
		return {
			cause: 'no-priced-pairing',
			title: `${candidateCount} stopover${candidateCount === 1 ? '' : 's'}, no priced trip`,
			detail: `The sources below found ${candidateCount === 1 ? 'a stopover' : 'stopovers'} between ${origin.code} and ${destination.code}, and none of them came back with a pair of flights these dates could be built from. Different dates might.`,
			sources,
			fix
		};
	}

	if (sources.length === 0) {
		return {
			cause: 'no-route-known',
			title: 'No flight source answered',
			detail: `Nothing was asked about ${origin.code} to ${destination.code}, so this screen is not a statement about the route.`,
			sources,
			fix
		};
	}

	const emptyHanded = sources.filter((line) => line.answer === 'nothing-found');
	const knewRoutes = sources.filter((line) => line.answer === 'answered');
	const everySourceEmpty = emptyHanded.length === sources.length;

	const title = everySourceEmpty
		? `No route out of ${origin.code} from these sources`
		: `No stopover found from ${origin.code} to ${destination.code}`;

	// Issue #340. Every sentence here names who said what, and none of them says more than
	// the source it names actually established.
	//
	// The three sentences this replaces were each false on the owner's own routes:
	//
	//   "No stopover from GRO reaches BVC"       — asserted absence; the app found three the
	//                                              day this was written.
	//   "none of them continues to Boa Vista"    — none of them was asked that. They were
	//                                              asked for a list of somewhere-cheap
	//                                              destinations, one per city, capped.
	//   "Later dates will not change that."      — an absolute claim about every future date
	//                                              from one query over one 30-day window.
	//
	// The last one was defended as safe because "a route graph is date-free". That holds for
	// Ryanair's bundled snapshot and for nothing else here: Kiwi has no route graph, and its
	// answer is a fare search over a window that moves with the calendar. A seasonal route
	// out of season reads as absent and comes back in November.
	//
	// A source that spent no request is also not a witness. Ryanair answering `0 reqs` about
	// Boa Vista means it read a snapshot that has never contained Cape Verde, and listing it
	// beside the others made two sources that cannot know look like corroboration.
	const sentences: string[] = [];
	if (emptyHanded.length > 0) {
		const who = joinLabels(emptyHanded.map((line) => line.label));
		sentences.push(
			`${who} ${emptyHanded.length === 1 ? 'has' : 'have'} no route out of ${airportLabel(origin)} in what ${emptyHanded.length === 1 ? 'it covers' : 'they cover'}.`
		);
	}
	if (knewRoutes.length > 0) {
		const who = joinLabels(knewRoutes.map((line) => line.label));
		sentences.push(
			`${who} ${knewRoutes.length === 1 ? 'knows' : 'know'} routes from ${origin.code}, and the ones this search checked did not continue to ${airportLabel(destination)}.`
		);
	}
	sentences.push(
		`That is what these sources returned, not a finding that no such trip exists: none of them was asked about every airport, and the two keyless ones answer for one airline and for a fixed departure window. A route flying in another season, or one only a source we did not ask sells, would look exactly like this.`
	);

	return { cause: 'no-route-known', title, detail: sentences.join(' '), sources, fix };
}

/** The one sentence that offers the fix, kept next to the copy it belongs with rather than
 * assembled inside a template. Names the quota because 50 free requests a month is the fact
 * that makes it a reasonable thing to ask of someone. */
export function fixSentence(fix: KeyGapFix, destination: NamedAirport): string {
	return `${fix.label} is a flight source this search never asked, because it needs a key. Its free tier is ${fix.monthlyQuota} requests a month, enough to search ${destination.code} and keep going.`;
}
