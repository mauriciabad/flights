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
 * The three cases below are distinguishable from data the page already holds, and each
 * one describes what happened rather than what might happen next. Kept as a pure function
 * so the wording is unit-testable without mounting Svelte, the same split the rest of
 * `$lib/results/view-model.ts` uses.
 */

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
}

export interface NoStaysNotice {
	title: string;
	description: string;
	/** Present only when there is a real control that changes the outcome. A link offered
	 * when the traveller has already done everything available is the same empty promise
	 * this function exists to remove. */
	action?: { label: string; href: string };
}

export function describeNoStays(context: NoStaysContext): NoStaysNotice {
	const place = context.cityName ?? 'this stopover';

	if (!context.stayProviderConfigured) {
		return {
			// The banner above the results list says this in the same words, on purpose.
			title: 'No stay provider configured',
			// Agoda over Booking.com for the same reason StayKeyNotice picks it: 500 free
			// requests a month against Booking's 50, enough to price every stopover one
			// search turns up.
			description: `No bed was searched for in ${place}, and none will be until a key is saved. Agoda's free tier covers 500 requests a month. Booking.com works too.`,
			action: { label: 'Add an Agoda key', href: '/settings/#agoda' }
		};
	}

	if (!context.searchDone) {
		return {
			title: `Looking for stays in ${place}…`,
			description: 'The search is still running. Rooms appear here as the providers answer.'
		};
	}

	return {
		title: `No stays came back for ${place}`,
		description: `The search finished. The stay providers had nothing near ${place} for these dates.`
	};
}
