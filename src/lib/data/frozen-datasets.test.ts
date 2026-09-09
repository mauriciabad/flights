import { describe, expect, it } from 'vitest';
import cheapRoutes from './cheap-routes.generated.json';
import directRoutes from './direct-routes.generated.json';
import ryanairNetwork from './ryanair-network.generated.json';
import { EXCHANGE_RATES } from './exchange-rates.generated';
import { FROZEN_DATASETS, formatFrozenDate } from './frozen-datasets';

/** The four sets a workflow used to refresh, each beside the day its own file says it was
 * fetched. The hand-built four have no such stamp, so nothing here can check them. */
const STAMPED = [
	['Exchange rates', EXCHANGE_RATES.fetchedAt],
	['Cheap fares', cheapRoutes.fetchedAt],
	['Direct routes', directRoutes.fetchedAt],
	['Ryanair network', ryanairNetwork.fetchedAt]
] as const;

describe('FROZEN_DATASETS', () => {
	// A date typed into a list beside a file is a date that can be wrong, and the screen
	// this feeds tells people how much to trust what they are looking at. So each stamped
	// row is read back off the data itself.
	it.each(STAMPED)('states the day %s was actually fetched', (name, fetchedAt) => {
		const row = FROZEN_DATASETS.find((dataset) => dataset.name === name);
		expect(row?.fetchedOn).toBe(fetchedAt.slice(0, 10));
	});

	it('names every set once and dates all of them', () => {
		const names = FROZEN_DATASETS.map((dataset) => dataset.name);
		expect(new Set(names).size).toBe(names.length);
		for (const dataset of FROZEN_DATASETS) {
			expect(dataset.fetchedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it('reads freshest first, so the worst date is the one at the bottom', () => {
		const dates = FROZEN_DATASETS.map((dataset) => dataset.fetchedOn);
		expect(dates).toEqual([...dates].sort().reverse());
	});
});

describe('formatFrozenDate', () => {
	it('writes the month out in full, with no padded day', () => {
		expect(formatFrozenDate('2026-09-07')).toBe('7 September 2026');
	});

	it('spells September the way this app spells it, not the way Node en-GB does', () => {
		expect(formatFrozenDate('2026-09-07')).not.toContain('Sept ');
	});

	it('hands back anything it cannot split, rather than printing NaN at a reader', () => {
		expect(formatFrozenDate('whenever')).toBe('whenever');
		expect(formatFrozenDate('2026-13-01')).toBe('2026-13-01');
	});
});
