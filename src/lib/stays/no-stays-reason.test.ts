import { describe, expect, it } from 'vitest';
import { describeNoStays } from './no-stays-reason';

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
			cityName: 'Bergamo'
		});
		expect(finished.title).toBe('No stays came back for Bergamo');
		expect(finished.description).toMatch(/finished/i);
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
});
