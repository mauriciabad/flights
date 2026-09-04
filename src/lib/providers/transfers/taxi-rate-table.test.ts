import { describe, expect, it } from 'vitest';
import { estimateTaxiFare, TAXI_RATE_TABLE } from './taxi-rate-table';

describe('estimateTaxiFare', () => {
	it('uses the matched country card and reports it as the source', () => {
		const estimate = estimateTaxiFare(5000, 'ES');

		expect(estimate.kind).toBe('estimate');
		expect(estimate.currency).toBe('EUR');
		expect(estimate.countryCode).toBe('ES');
		expect(estimate.rateSource).toBe('country');
		expect(estimate.citation.length).toBeGreaterThan(0);
	});

	it('falls back to the generic card for a country with no dedicated entry', () => {
		const estimate = estimateTaxiFare(5000, 'ZZ');

		expect(estimate.rateSource).toBe('fallback');
		expect(estimate.currency).toBe('EUR');
	});

	it('always returns a range, never a single figure masquerading as one', () => {
		const estimate = estimateTaxiFare(3000, 'FR');
		expect(estimate.lowMinorUnits).toBeLessThanOrEqual(estimate.highMinorUnits);
		// A single-figure estimate (low === high) would be indistinguishable from a real
		// quote at the call site; every entry's per-km low/high differ, so a real distance
		// must produce a real spread.
		expect(estimate.lowMinorUnits).toBeLessThan(estimate.highMinorUnits);
	});

	it('grows both bounds with distance', () => {
		const near = estimateTaxiFare(1000, 'DE');
		const far = estimateTaxiFare(20_000, 'DE');
		expect(far.lowMinorUnits).toBeGreaterThan(near.lowMinorUnits);
		expect(far.highMinorUnits).toBeGreaterThan(near.highMinorUnits);
	});

	it('at zero distance, the range collapses to the flag-down fee alone', () => {
		const estimate = estimateTaxiFare(0, 'ES');
		const card = TAXI_RATE_TABLE.ES;
		expect(estimate.lowMinorUnits).toBe(card.flagDownMinorUnits[0]);
		expect(estimate.highMinorUnits).toBe(card.flagDownMinorUnits[1]);
	});

	it('rejects a negative distance rather than returning a nonsensical estimate', () => {
		expect(() => estimateTaxiFare(-1, 'ES')).toThrow(/non-negative/);
	});

	it('every table entry has a low bound at or below its high bound, for both fee components', () => {
		for (const [countryCode, card] of Object.entries(TAXI_RATE_TABLE)) {
			expect(card.flagDownMinorUnits[0], `${countryCode} flag-down`).toBeLessThanOrEqual(
				card.flagDownMinorUnits[1]
			);
			expect(card.perKmMinorUnits[0], `${countryCode} per-km`).toBeLessThanOrEqual(card.perKmMinorUnits[1]);
			expect(card.citation.length, `${countryCode} citation`).toBeGreaterThan(0);
		}
	});
});
