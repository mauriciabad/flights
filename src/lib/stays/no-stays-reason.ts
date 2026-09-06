/**
 * Issue #140: what the stay picker says when it has no stays to show.
 *
 * It used to say one sentence for all of them: "Nothing has come back for this connection
 * so far - try again once the search finishes, or widen the search radius." On the search
 * the issue was filed against, every clause of that was wrong. The search had finished.
 * Nothing had come back because no stay provider is configured, so nothing was ever asked.
 * And there is no radius control to widen. Two screens above, the same page said the true
 * thing ("No stay provider configured"), so the app contradicted itself about one fact.
 *
 * ## Issue #203: the same mistake, one layer along
 *
 * Once `providers/stays/hostelworld.ts` became the keyless baseline (#202), the branch this
 * function reaches for almost every visitor is the last one, and that branch was asserting
 * something nobody had observed. Measured 2026-09-05 against a production build, with
 * Hostelworld answering `503` six times and the provider strip correctly reading FAILED,
 * the stopover still said "The search finished. The stay providers had nothing near London
 * for these dates." Nobody learned that. What we learned is that Hostelworld returned 503.
 *
 * So the outcome of each stay provider is now an input, and the three cases issue #203
 * separates get three different answers:
 *
 * 1. **Asked, answered, nothing here.** Final and honest. Hostelworld sells hostels and
 *    budget hotels rather than the whole market, so a key for a broader provider is a real
 *    thing to try, and that is the only reason a link appears.
 * 2. **Asked, failed.** The provider's own sentence and status code, verbatim, straight out
 *    of `ProviderError.message` (`providers/response-evidence.ts` builds it). No action:
 *    somebody else's outage is not evidence that a different provider has a bed here, and
 *    this function's own rule is that a link appears only where it changes the outcome.
 * 3. **Never asked, because nothing is configured.** What `StayKeyNotice` was written for,
 *    and unreachable from the page while a keyless provider stays registered.
 *
 * ## Issue #185: why the cause lives here and almost nowhere else
 *
 * The missing bed was announced seven times on one results screen. Each announcement was
 * true and each was added for a good local reason, and together they were louder than the
 * result. The split now is: every other place states its own fact about its own number or
 * its own row, and this function is the one place that says WHY and what to do about it.
 * It is per stopover rather than per page because case 1 is a fact about one city, and it
 * appears only inside the stopover's own fold, which a traveller opens by asking.
 *
 * ## Issue #374: the other half, which nobody had written
 *
 * Everything above answers an EMPTY list, and that turned out to be the smaller problem. A
 * keyless visitor searching Porto gets 54 hostels off Hostelworld and a screen that reads
 * as the whole market, because the only function here that could have said otherwise never
 * runs when there is something to show. The owner's own preferred bed is a Booking.com
 * listing that was never fetched and never mentioned. `describeStayCatalogue`, at the
 * bottom of this file, is the same question asked of a POPULATED list, and it shares this
 * module's helpers so the two cannot name a provider, count it or link to it differently.
 *
 * Both are kept as pure functions so the wording is unit-testable without mounting Svelte,
 * the same split the rest of `$lib/results/view-model.ts` uses.
 */

import type { ProviderAnswer } from '$lib/search';

/** What one stay provider did in this search, as the notice has to describe it. Built from
 * `SearchSnapshot.providers` by `results/provider-setup.ts`, so the sentence here and the
 * plate in `ProviderStatusStrip` are reading the same record. */
export interface StayProviderOutcome {
	/** The adapter's registry label, e.g. `Hostelworld (no key required)`, so the notice
	 * names the provider the same way the strip above the list does. */
	label: string;
	answer: ProviderAnswer;
	/** `ProviderError.message`, verbatim and unedited. It already opens with the provider's
	 * name, carries its status code and quotes its own sentence — that is what
	 * `providers/response-evidence.ts` builds it to do. Never replaced with a sentence of
	 * ours, and never summarised (AGENTS.md, "Show the error you got, never the one you
	 * assumed"). */
	errorMessage?: string;
}

/** What the picker knows about why its property list is empty. */
export interface NoStaysContext {
	/** `hasUsableStayProvider(keyStore.availableKeys)`. False means no request was made,
	 * not that a request came back empty. */
	stayProviderConfigured: boolean;
	/** Whether the search that would have filled the list has finished. While it is
	 * running, "nothing yet" is the one honest thing to say. */
	searchDone: boolean;
	/** The connection city, for a sentence that names the place rather than "this
	 * connection". Omitted before the airport dataset resolves. */
	cityName?: string;
	/** Issue #203: every stay provider this search actually touched. Empty means no call
	 * has been recorded, which is a different thing from "they all came back empty" and is
	 * described as such rather than being folded into the friendlier of the two. */
	stayProviders?: readonly StayProviderOutcome[];
	/** Registry labels of the stay providers still waiting on a key
	 * (`results/provider-setup.ts`). Gates the only link this function offers outside case
	 * 3: with an empty list, "add a key" is advice the traveller has already taken. The
	 * labels themselves are used, not only the length, so the sentence names whoever is
	 * actually missing (issue #374). */
	unconfiguredStayProviders?: readonly string[];
}

export interface NoStaysNotice {
	title: string;
	description: string;
	/** Present only when there is a real control that changes the outcome. A link offered
	 * when the traveller has already done everything available is the same empty promise
	 * this function exists to remove. */
	action?: { label: string; href: string };
	/** Issue #203: the failed providers' own messages, each already carrying its status
	 * code. Rendered apart from `description` so a caller can style our sentence and their
	 * sentence differently, and so no caller can accidentally paraphrase one into the
	 * other. Empty when nothing failed. */
	providerFailures: string[];
}

/** Agoda over Booking.com wherever one provider has to be named: 500 free requests a month
 * against Booking's 50 (`settings/provider-catalog.ts`), enough to price every stopover a
 * single search turns up. `StayKeyNotice` picks it for the same reason. */
const ADD_KEY_ACTION = { label: 'Add an Agoda key', href: '/settings/#agoda' } as const;

/**
 * The one "add a key" link, aimed at a provider this traveller is actually missing.
 *
 * Issue #374: `ADD_KEY_ACTION` used to be offered on nothing more than "something is
 * unconfigured", so a visitor who had already saved an Agoda key and was only missing
 * Booking was sent to the Agoda row he had already filled in. Deriving the link from the
 * same list the sentence is built from is what stops the two disagreeing.
 */
function addKeyAction(unconfigured: readonly string[]): { label: string; href: string } | undefined {
	if (unconfigured.length === 0) return undefined;
	if (unconfigured.some((label) => brandOf(label) === 'Agoda')) return ADD_KEY_ACTION;
	// The settings page anchors each card on the provider's id (`ProviderKeyCard`), and what
	// this function holds is the registry label. Deriving `#booking` from
	// `Booking.com (RapidAPI)` is a guess, and a guessed anchor lands nowhere, so the page
	// itself is the honest target.
	return { label: `Add a ${brandOf(unconfigured[0])} key`, href: '/settings/' };
}

/** "Hostelworld", or "Hostelworld and Agoda", or "Hostelworld, Agoda and Booking.com".
 * Takes names rather than outcomes because callers name providers two ways: by registry
 * label where the notice sits beside `ProviderStatusStrip`, and by brand mid-sentence. */
function nameList(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? 'The stay providers';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** `Hostelworld (no key required)` becomes `Hostelworld`. A client labels its own messages
 * with the host it called; the registry label adds how that host is reached. They name the
 * same provider and never match as strings, so the comparison is made on the part they
 * share. */
function brandOf(label: string): string {
	return label.split(' (')[0];
}

/**
 * One line per failed provider, its own message untouched.
 *
 * The label is prepended only when the message does not already carry it. An HTTP failure
 * arrives as "Hostelworld returned HTTP 503: …" and needs nothing; a network failure arrives
 * as the browser's own two words, "Failed to fetch", and with two providers down a reader
 * cannot tell whose two words they are. Prefixing is attribution, not editing — nothing
 * inside the provider's sentence changes.
 *
 * A failure with no message at all is itself worth saying plainly, rather than printing an
 * empty quote or dropping the provider from the list of things that went wrong.
 */
function failureLines(failed: readonly StayProviderOutcome[]): string[] {
	return failed.map((outcome) => {
		if (outcome.errorMessage === undefined) return `${outcome.label} failed without saying why.`;
		return outcome.errorMessage.startsWith(brandOf(outcome.label))
			? outcome.errorMessage
			: `${outcome.label}: ${outcome.errorMessage}`;
	});
}

export function describeNoStays(context: NoStaysContext): NoStaysNotice {
	const place = context.cityName ?? 'this stopover';
	const providers = context.stayProviders ?? [];

	if (!context.stayProviderConfigured) {
		return {
			// The banner above the results list says this in the same words, on purpose.
			title: 'No stay provider configured',
			description: `No bed was searched for in ${place}, and none will be until a key is saved. Agoda's free tier covers 500 requests a month. Booking.com works too.`,
			action: ADD_KEY_ACTION,
			providerFailures: []
		};
	}

	if (!context.searchDone) {
		return {
			title: `Looking for stays in ${place}…`,
			description: 'The search is still running. Rooms appear here as the providers answer.',
			providerFailures: []
		};
	}

	const failed = providers.filter((outcome) => outcome.answer === 'failed');
	const replied = providers.filter(
		(outcome) => outcome.answer === 'answered' || outcome.answer === 'nothing-found'
	);
	const unconfigured = context.unconfiguredStayProviders ?? [];
	// Brands, not registry labels: "Agoda (RapidAPI) reaches more of the market" tells a
	// traveller how we call the provider, which is not what the sentence is about.
	const widerProviderOffer =
		unconfigured.length > 0
			? ` ${nameList(unconfigured.map(brandOf))} ${unconfigured.length === 1 ? 'reaches' : 'reach'} more of the market than hostels do.`
			: '';
	const widerProviderAction = addKeyAction(unconfigured);

	// Case 2. Everything that ran failed, so there is no answer about this city at all —
	// only a record of who could not give one. Saying anything about what is or is not near
	// the place would be inventing the answer we did not get.
	if (failed.length > 0 && replied.length === 0) {
		return {
			title: failed.length === 1 ? `${failed[0].label} could not answer` : 'No stay provider could answer',
			description: `Nothing is known about beds in ${place}: every stay provider this search asked failed.`,
			providerFailures: failureLines(failed)
		};
	}

	// One answered and another did not. "Nothing near here" is then only true of the ones
	// that replied, and the one that failed might have had a bed, so both halves are said.
	if (failed.length > 0) {
		return {
			title: `No stays came back for ${place}`,
			description: `${nameList(replied.map((outcome) => outcome.label))} had nothing near ${place} for these dates, and the rest could not answer.`,
			action: widerProviderAction,
			providerFailures: failureLines(failed)
		};
	}

	// Case 1. Asked and answered: a real, final "no beds here" for the providers that ran.
	if (replied.length > 0) {
		return {
			title: `No stays came back for ${place}`,
			description: `${nameList(replied.map((outcome) => outcome.label))} answered with nothing near ${place} for these dates.${widerProviderOffer}`,
			action: widerProviderAction,
			providerFailures: []
		};
	}

	// Nothing recorded at all. The search finished without this stopover's stay lookup ever
	// resolving — a shared per-search ration ran out (`budget/stay-lookup-budget.ts`), or
	// the call was dropped. Whatever the reason, "they had nothing here" is not it.
	return {
		title: `No stays came back for ${place}`,
		description: `The search finished without a stay provider answering for ${place}.`,
		providerFailures: []
	};
}

/** What a POPULATED stay list is drawn from, and what it is missing. */
export interface StayCatalogueContext {
	/** How many properties are on screen right now. */
	propertyCount: number;
	stayProviders?: readonly StayProviderOutcome[];
	unconfiguredStayProviders?: readonly string[];
}

export interface StayCatalogueNote {
	description: string;
	action?: { label: string; href: string };
	providerFailures: string[];
}

/**
 * Issue #374: the footnote under a stay list that came from fewer providers than exist.
 *
 * `describeNoStays` only ever renders when the list is empty, so a keyless visitor who got
 * 54 Porto hostels off Hostelworld saw a screen that read as the whole market. It is one
 * provider's catalogue. The owner's own preferred bed, Oporto Sea Rooms, is a Booking.com
 * listing, so it was never asked for and he was never told why.
 *
 * This is deliberately quiet. Something IS on screen and it is usable, so the note is a
 * footnote under the alternatives rather than a banner over them, and it appears only when
 * a provider is genuinely absent. A complete catalogue says nothing at all.
 *
 * Both sentences name brands rather than registry labels. `Hostelworld (no key required)`
 * is the right way to write a provider on a status plate and noise in the middle of a
 * sentence about who has the beds.
 */
export function describeStayCatalogue(context: StayCatalogueContext): StayCatalogueNote | undefined {
	const providers = context.stayProviders ?? [];
	// Only a provider that returned rows can be credited with the list. `nothing-found` was
	// asked and gave nothing, so "Hostelworld and Agoda listed these 54 properties" would
	// be a false sentence about Agoda, and it is not missing either — it answered.
	const listed = providers.filter((outcome) => outcome.answer === 'answered');
	const failed = providers.filter((outcome) => outcome.answer === 'failed');
	const unconfigured = context.unconfiguredStayProviders ?? [];

	// Nothing recorded, so there is no source to name, and naming one would be the guess
	// AGENTS.md forbids. The properties on screen came from somewhere; this function does
	// not know where, and says nothing rather than something plausible.
	if (listed.length === 0) return undefined;

	// Nothing is missing, so there is nothing to say. A note here would be the eighth
	// announcement issue #185 cut back to one.
	if (failed.length === 0 && unconfigured.length === 0) return undefined;

	const source = `${nameList(listed.map((outcome) => brandOf(outcome.label)))} listed ${
		context.propertyCount === 1 ? 'this one property' : `these ${context.propertyCount} properties`
	}.`;

	const missing: string[] = [];
	if (unconfigured.length > 0) {
		missing.push(
			`${nameList(unconfigured.map(brandOf))} ${unconfigured.length === 1 ? 'has' : 'have'} no key saved`
		);
	}
	if (failed.length > 0) {
		missing.push(`${nameList(failed.map((outcome) => brandOf(outcome.label)))} could not answer`);
	}
	// The pronoun agrees with everyone absent, not with the clause it sits behind: one
	// unconfigured provider plus one that failed is still "they".
	const absent = unconfigured.length + failed.length;
	const gap = `${missing.join(' and ')}, so a bed only ${absent === 1 ? 'it carries' : 'they carry'} is missing from this list.`;

	return {
		description: `${source} ${gap}`,
		action: addKeyAction(unconfigured),
		providerFailures: failureLines(failed)
	};
}
