import { describe, expect, it } from 'vitest';
import { describeNoStays, describeStayCatalogue, type StayProviderOutcome } from './no-stays-reason';

/** The registry labels `results/provider-setup.ts` hands over, spelled the way the registry
 * spells them, so a test that passes here passes on the real page too. */
const AGODA = 'Agoda (RapidAPI)';
const BOOKING = 'Booking.com (RapidAPI)';

/** The keyless baseline every visitor gets since #202, answering normally. */
const hostelworldAnswered: StayProviderOutcome = {
	label: 'Hostelworld (no key required)',
	answer: 'nothing-found'
};

/**
 * The failure this suite exists for. The message is `ProviderError.message` exactly as
 * `providers/response-evidence.ts` builds it, so it already carries the provider's name, its
 * status code and its own sentence.
 */
const hostelworldFailed: StayProviderOutcome = {
	label: 'Hostelworld (no key required)',
	answer: 'failed',
	errorMessage:
		'Hostelworld returned HTTP 400: please pass valid currency three letter code'
};

describe('describeNoStays', () => {
	it('says nothing was searched, and offers the key, when no stay provider is configured', () => {
		const notice = describeNoStays({
			stayProviderConfigured: false,
			searchDone: true,
			cityName: 'Bergamo'
		});
		expect(notice.title).toBe('No stay provider configured');
		expect(notice.description).toContain('Bergamo');
		expect(notice.action).toEqual({ label: 'Add an Agoda key', href: '/settings/#agoda' });
	});

	it('matches the banner above the results list word for word, so the page cannot contradict itself', () => {
		// `StayKeyNotice.svelte` renders `title="No stay provider configured"` from the same
		// underlying check (`hasUsableStayProvider`). Issue #140 was the two disagreeing.
		const notice = describeNoStays({ stayProviderConfigured: false, searchDone: true });
		expect(notice.title).toBe('No stay provider configured');
	});

	it('only says it is still looking while the search is actually running', () => {
		const running = describeNoStays({
			stayProviderConfigured: true,
			searchDone: false,
			cityName: 'Bergamo'
		});
		expect(running.title).toBe('Looking for stays in Bergamo…');
		expect(running.description).toMatch(/still running/i);
	});

	it('never tells a traveller to wait for a search that has finished', () => {
		const finished = describeNoStays({
			stayProviderConfigured: true,
			searchDone: true,
			cityName: 'Bergamo',
			stayProviders: [hostelworldAnswered]
		});
		expect(finished.title).toBe('No stays came back for Bergamo');
		expect(finished.description).not.toMatch(/try again/i);
		expect(finished.description).not.toMatch(/\byet\b/i);
	});

	it('offers no action when there is no control that would change the outcome', () => {
		expect(describeNoStays({ stayProviderConfigured: true, searchDone: true }).action).toBeUndefined();
		expect(describeNoStays({ stayProviderConfigured: true, searchDone: false }).action).toBeUndefined();
	});

	it('falls back to a neutral phrase before the airport dataset resolves a city name', () => {
		const notice = describeNoStays({ stayProviderConfigured: true, searchDone: true });
		expect(notice.title).toBe('No stays came back for this stopover');
	});

	/**
	 * Issue #203, case 1: asked, answered, nothing here. Final and honest, and the one state
	 * where a broader provider is worth suggesting, since Hostelworld sells hostels and
	 * budget hotels rather than the whole market.
	 */
	describe('when the providers answered and had nothing', () => {
		it('names who answered and does not dress it up as a failure', () => {
			const notice = describeNoStays({
				stayProviderConfigured: true,
				searchDone: true,
				cityName: 'London',
				stayProviders: [hostelworldAnswered]
			});
			expect(notice.description).toBe(
				'Hostelworld (no key required) answered with nothing near London for these dates.'
			);
			expect(notice.providerFailures).toEqual([]);
		});

		it('offers a broader provider only while one is still unconfigured', () => {
			const context = {
				stayProviderConfigured: true,
				searchDone: true,
				cityName: 'London',
				stayProviders: [hostelworldAnswered]
			};
			expect(
				describeNoStays({ ...context, unconfiguredStayProviders: [AGODA, BOOKING] }).action
			).toEqual({ label: 'Add an Agoda key', href: '/settings/#agoda' });
			// Everything is already configured, so "add a key" is advice already taken.
			expect(describeNoStays({ ...context, unconfiguredStayProviders: [] }).action).toBeUndefined();
		});

		/**
		 * Issue #374. This sentence used to name Agoda and Booking.com whatever was missing,
		 * so a traveller who had already saved an Agoda key was told to go and get the thing
		 * he had, and the link under it pointed at the row he had already filled in.
		 */
		it('names the providers actually missing, and links to one of them', () => {
			const context = {
				stayProviderConfigured: true,
				searchDone: true,
				cityName: 'London',
				stayProviders: [hostelworldAnswered]
			};
			const bothMissing = describeNoStays({ ...context, unconfiguredStayProviders: [AGODA, BOOKING] });
			expect(bothMissing.description).toBe(
				'Hostelworld (no key required) answered with nothing near London for these dates. Agoda and Booking.com reach more of the market than hostels do.'
			);

			const onlyBooking = describeNoStays({ ...context, unconfiguredStayProviders: [BOOKING] });
			expect(onlyBooking.description).toBe(
				'Hostelworld (no key required) answered with nothing near London for these dates. Booking.com reaches more of the market than hostels do.'
			);
			expect(onlyBooking.description).not.toContain('Agoda');
			expect(onlyBooking.action).toEqual({ label: 'Add a Booking.com key', href: '/settings/' });
		});
	});

	/**
	 * Issue #203, case 2, and the reason this function was rewritten. Measured 2026-09-05
	 * against a production build with Hostelworld forced to `503`: the strip correctly read
	 * FAILED and this notice still said "The stay providers had nothing near London for
	 * these dates." Nobody ever learned that.
	 */
	describe('when every stay provider failed', () => {
		const failing = {
			stayProviderConfigured: true,
			searchDone: true,
			cityName: 'London',
			stayProviders: [hostelworldFailed]
		};

		it('never claims there is nothing near the city, because nobody found out', () => {
			const notice = describeNoStays(failing);
			expect(notice.description).not.toMatch(/nothing near/i);
			expect(notice.description).not.toMatch(/had nothing/i);
			expect(notice.description).toContain('Nothing is known about beds in London');
		});

		it("carries the provider's own sentence and status code, unedited", () => {
			const notice = describeNoStays(failing);
			expect(notice.providerFailures).toEqual([
				'Hostelworld returned HTTP 400: please pass valid currency three letter code'
			]);
		});

		it('names the one provider that failed in the title', () => {
			expect(describeNoStays(failing).title).toBe('Hostelworld (no key required) could not answer');
			expect(
				describeNoStays({
					...failing,
					stayProviders: [hostelworldFailed, { label: 'Agoda (RapidAPI)', answer: 'failed', errorMessage: 'x' }]
				}).title
			).toBe('No stay provider could answer');
		});

		// The orchestrator's ruling for this PR, recorded so a future reader knows it was a
		// decision and not an omission: an outage is not evidence that a different provider
		// has a bed here, and a button beside a 503 reads as "press this and it will work".
		it('offers no action, even when a broader provider is unconfigured', () => {
			expect(
				describeNoStays({ ...failing, unconfiguredStayProviders: [AGODA, BOOKING] }).action
			).toBeUndefined();
		});

		// The browser's own words for a blocked request, which is what a `network-error`
		// carries. Two words are honest and unattributable, so the provider's name goes in
		// front of them — attribution, not editing.
		it('attributes a message that does not already name the provider', () => {
			const notice = describeNoStays({
				...failing,
				stayProviders: [
					{ label: 'Hostelworld (no key required)', answer: 'failed', errorMessage: 'Failed to fetch' }
				]
			});
			expect(notice.providerFailures).toEqual(['Hostelworld (no key required): Failed to fetch']);
		});

		// The client labels its own messages with the host it called ("Hostelworld"); the
		// registry label adds how that host is reached. Prefixing on a plain string match
		// would print the name twice.
		it('does not name the provider twice when its own message already does', () => {
			expect(describeNoStays(failing).providerFailures).toEqual([
				'Hostelworld returned HTTP 400: please pass valid currency three letter code'
			]);
		});

		it('says so plainly when a failure carried no message at all', () => {
			const notice = describeNoStays({
				...failing,
				stayProviders: [{ label: 'Agoda (RapidAPI)', answer: 'failed' }]
			});
			expect(notice.providerFailures).toEqual(['Agoda (RapidAPI) failed without saying why.']);
		});
	});

	it('says both halves when one provider answered and another failed', () => {
		const notice = describeNoStays({
			stayProviderConfigured: true,
			searchDone: true,
			cityName: 'London',
			stayProviders: [hostelworldAnswered, { label: 'Agoda (RapidAPI)', answer: 'failed', errorMessage: 'boom' }]
		});
		// "Nothing near London" is only true of the one that replied; the one that failed
		// might have had a bed, and the sentence must not quietly speak for it.
		expect(notice.description).toBe(
			'Hostelworld (no key required) had nothing near London for these dates, and the rest could not answer.'
		);
		expect(notice.providerFailures).toEqual(['Agoda (RapidAPI): boom']);
	});

	it('does not claim an answer nobody gave when no stay call was recorded', () => {
		const notice = describeNoStays({
			stayProviderConfigured: true,
			searchDone: true,
			cityName: 'London',
			stayProviders: []
		});
		expect(notice.description).toBe('The search finished without a stay provider answering for London.');
		expect(notice.description).not.toMatch(/nothing near/i);
	});
});

/**
 * Issue #374. The defect: a keyless visitor searching Porto got 54 Hostelworld hostels and
 * a screen that read as the whole market, because `describeNoStays` only ever speaks when
 * the list is empty. The owner's own preferred bed, Oporto Sea Rooms, is a Booking.com
 * listing he was never shown and never told about.
 *
 * The sentences are asserted whole rather than by fragment. This is the one place a
 * traveller reads why the list is short, and a change to the wording should be a decision,
 * not a diff nobody noticed.
 */
describe('describeStayCatalogue', () => {
	const hostelworldListed: StayProviderOutcome = {
		label: 'Hostelworld (no key required)',
		answer: 'answered'
	};
	const bookingFailed: StayProviderOutcome = {
		label: BOOKING,
		answer: 'failed',
		errorMessage: 'Booking.com returned HTTP 503: service unavailable'
	};

	it('tells a keyless visitor whose catalogue the 54 Porto hostels came from', () => {
		const note = describeStayCatalogue({
			propertyCount: 54,
			stayProviders: [hostelworldListed],
			unconfiguredStayProviders: [AGODA, BOOKING]
		});
		expect(note?.description).toBe(
			'Hostelworld listed these 54 properties. Agoda and Booking.com have no key saved, so a bed only they carry is missing from this list.'
		);
		expect(note?.action).toEqual({ label: 'Add an Agoda key', href: '/settings/#agoda' });
		expect(note?.providerFailures).toEqual([]);
	});

	it('says a provider could not answer, and offers no key for an outage', () => {
		const note = describeStayCatalogue({
			propertyCount: 12,
			stayProviders: [hostelworldListed, bookingFailed]
		});
		expect(note?.description).toBe(
			'Hostelworld listed these 12 properties. Booking.com could not answer, so a bed only it carries is missing from this list.'
		);
		// A key is not the fix for somebody else's 503, and a button beside one reads as
		// "press this and it will work" — the ruling `describeNoStays` already follows.
		expect(note?.action).toBeUndefined();
		expect(note?.providerFailures).toEqual(['Booking.com returned HTTP 503: service unavailable']);
	});

	it('joins a missing key and a failure into one sentence, and counts them together', () => {
		const note = describeStayCatalogue({
			propertyCount: 12,
			stayProviders: [hostelworldListed, bookingFailed],
			unconfiguredStayProviders: [AGODA]
		});
		expect(note?.description).toBe(
			'Hostelworld listed these 12 properties. Agoda has no key saved and Booking.com could not answer, so a bed only they carry is missing from this list.'
		);
	});

	// The eighth announcement issue #185 cut back to one. Everything answered means the list
	// is the catalogue, and a footnote saying so is noise.
	it('says nothing when every stay provider answered', () => {
		expect(
			describeStayCatalogue({
				propertyCount: 12,
				stayProviders: [hostelworldListed, { label: AGODA, answer: 'answered' }, { label: BOOKING, answer: 'nothing-found' }]
			})
		).toBeUndefined();
	});

	// No record of a call means no source to name. Naming one anyway is the guess AGENTS.md
	// forbids, and the list on screen is still perfectly usable without this note.
	it('says nothing when no provider outcome was recorded at all', () => {
		expect(
			describeStayCatalogue({ propertyCount: 12, stayProviders: [], unconfiguredStayProviders: [AGODA, BOOKING] })
		).toBeUndefined();
		expect(describeStayCatalogue({ propertyCount: 12, unconfiguredStayProviders: [AGODA] })).toBeUndefined();
	});

	// A provider that searched and found nothing here did not put any of these properties on
	// screen, so crediting it with them is a false sentence. It is not missing either: it
	// was asked and it answered, which is why it earns no clause of its own.
	it('does not credit a provider that answered with nothing', () => {
		const note = describeStayCatalogue({
			propertyCount: 3,
			stayProviders: [hostelworldListed, { label: AGODA, answer: 'nothing-found' }],
			unconfiguredStayProviders: [BOOKING]
		});
		expect(note?.description).toBe(
			'Hostelworld listed these 3 properties. Booking.com has no key saved, so a bed only it carries is missing from this list.'
		);
	});

	// Every provider was asked and none returned a row, so there is no source to name and
	// the list on screen came from somewhere this function cannot see.
	it('says nothing when no provider returned a single property', () => {
		expect(
			describeStayCatalogue({
				propertyCount: 3,
				stayProviders: [hostelworldAnswered],
				unconfiguredStayProviders: [BOOKING]
			})
		).toBeUndefined();
	});

	it('counts one property as one property', () => {
		const note = describeStayCatalogue({
			propertyCount: 1,
			stayProviders: [hostelworldListed],
			unconfiguredStayProviders: [BOOKING]
		});
		expect(note?.description).toBe(
			'Hostelworld listed this one property. Booking.com has no key saved, so a bed only it carries is missing from this list.'
		);
	});

	// `Hostelworld (no key required)` is the right way to write a provider on a status
	// plate. Mid-sentence it is noise about how we reach the host, not about who has beds.
	it('names brands, not the registry labels the status strip uses', () => {
		const note = describeStayCatalogue({
			propertyCount: 4,
			stayProviders: [hostelworldListed],
			unconfiguredStayProviders: [AGODA, BOOKING]
		});
		expect(note?.description).not.toContain('(no key required)');
		expect(note?.description).not.toContain('(RapidAPI)');
	});

	// AGENTS.md, "Show the error you got, never the one you assumed". The verbatim message
	// carries the status code, and nothing here rewrites it.
	it("passes each failed provider's own message through untouched", () => {
		const note = describeStayCatalogue({
			propertyCount: 2,
			stayProviders: [hostelworldListed, { label: AGODA, answer: 'failed', errorMessage: 'Failed to fetch' }]
		});
		expect(note?.providerFailures).toEqual(['Agoda (RapidAPI): Failed to fetch']);
	});
});
