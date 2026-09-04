import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
import { createSearchDependencies } from './search-dependencies';

/**
 * Issue #158: the tripwire for a whole class of bug, not only for this one field.
 *
 * `SearchDependencies.currency` was declared, documented, threaded correctly through
 * `pipeline.ts` and `resources.ts` by #154, and never set by the only code that builds the
 * object for a real search. Every unit test below it supplied `currency: 'EUR'` by hand, so
 * the suite was green while the app asked Agoda for no currency at all, got USD back, and
 * dropped the one candidate that had managed to price a bed. The diff looked complete; the
 * top of the chain was `undefined`.
 *
 * The field is required now, so this exact omission is a compile error. These tests cover
 * what the type cannot: that the value handed over is a real one rather than an empty string
 * or a stray `undefined` smuggled in past the type, and that nothing else in the object is
 * left hollow the same way.
 */
describe('createSearchDependencies', () => {
	it('names the currency every provider will be asked to quote in', () => {
		const deps = createSearchDependencies({});

		expect(deps.currency).toBe(DEFAULT_SEARCH_CURRENCY);
		expect(deps.currency).toMatch(/^[A-Z]{3}$/);
	});

	it('leaves nothing it does set holding undefined', () => {
		const deps = createSearchDependencies({ agoda: { apiKey: 'k' } });

		const hollow = Object.entries(deps)
			.filter(([, value]) => value === undefined)
			.map(([key]) => key);
		expect(hollow).toEqual([]);
	});

	it('passes the travellers own keys straight through', () => {
		const keys = { agoda: { apiKey: 'k' } };
		expect(createSearchDependencies(keys).keys).toBe(keys);
	});

	it('registers real flight and stay adapters to run against', () => {
		const deps = createSearchDependencies({});

		expect(deps.registry.ofKind('flight').length).toBeGreaterThan(0);
		expect(deps.registry.ofKind('stay').length).toBeGreaterThan(0);
	});
});
