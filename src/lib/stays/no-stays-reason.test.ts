import { describe, expect, it } from 'vitest';
import { describeNoStays, type StayProviderOutcome } from './no-stays-reason';

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
			expect(describeNoStays({ ...context, hasUnconfiguredStayProvider: true }).action).toEqual({
				label: 'Add an Agoda key',
				href: '/settings/#agoda'
			});
			// Everything is already configured, so "add a key" is advice already taken.
			expect(describeNoStays({ ...context, hasUnconfiguredStayProvider: false }).action).toBeUndefined();
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
			expect(describeNoStays({ ...failing, hasUnconfiguredStayProvider: true }).action).toBeUndefined();
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
		expect(notice.providerFailures).toEqual(['boom']);
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
