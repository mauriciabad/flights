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
 * Kept as a pure function so the wording is unit-testable without mounting Svelte, the same
 * split the rest of `$lib/results/view-model.ts` uses.
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
	/** Whether a registered stay provider is still waiting on a key. Gates the only link
	 * this function offers outside case 3: without one, "add a key" is advice the traveller
	 * has already taken. */
	hasUnconfiguredStayProvider?: boolean;
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

/** "Hostelworld", or "Hostelworld and Agoda", or "Hostelworld, Agoda and Booking.com". */
function nameList(outcomes: readonly StayProviderOutcome[]): string {
	const labels = outcomes.map((outcome) => outcome.label);
	if (labels.length <= 1) return labels[0] ?? 'The stay providers';
	return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
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
	const widerProviderOffer = context.hasUnconfiguredStayProvider
		? ` Agoda and Booking.com reach more of the market than hostels do.`
		: '';
	const widerProviderAction = context.hasUnconfiguredStayProvider ? ADD_KEY_ACTION : undefined;

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
			description: `${nameList(replied)} had nothing near ${place} for these dates, and the rest could not answer.`,
			action: widerProviderAction,
			providerFailures: failureLines(failed)
		};
	}

	// Case 1. Asked and answered: a real, final "no beds here" for the providers that ran.
	if (replied.length > 0) {
		return {
			title: `No stays came back for ${place}`,
			description: `${nameList(replied)} answered with nothing near ${place} for these dates.${widerProviderOffer}`,
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
