import { describe, expect, it } from 'vitest';
import {
	estimateTaxiFare,
	MAX_RATED_TAXI_DISTANCE_KM,
	TAXI_RATE_TABLE,
	type TaxiFareRange
} from './taxi-rate-table';

/** Narrows to the priced answer, so a test about the numbers fails loudly rather than
 * silently reading `undefined` off the refusal. */
function range(distanceMeters: number, countryCode: string): TaxiFareRange {
	const result = estimateTaxiFare(distanceMeters, countryCode);
	if (result.kind !== 'estimate') {
		throw new Error(`expected a fare range for ${distanceMeters}m in ${countryCode}`);
	}
	return result;
}

describe('estimateTaxiFare', () => {
	it('uses the matched country card and reports it as the source', () => {
		const estimate = range(5000, 'ES');

		expect(estimate.currency).toBe('EUR');
		expect(estimate.countryCode).toBe('ES');
		expect(estimate.rateSource).toBe('country');
		expect(estimate.citation.length).toBeGreaterThan(0);
	});

	it('falls back to the generic card for a country with no dedicated entry', () => {
		const estimate = range(5000, 'ZZ');

		expect(estimate.rateSource).toBe('fallback');
		expect(estimate.currency).toBe('EUR');
	});

	it('always returns a range, never a single figure masquerading as one', () => {
		const estimate = range(3000, 'FR');
		expect(estimate.lowMinorUnits).toBeLessThanOrEqual(estimate.highMinorUnits);
		// A single-figure estimate (low === high) would be indistinguishable from a real
		// quote at the call site; every entry's per-km low/high differ, so a real distance
		// must produce a real spread.
		expect(estimate.lowMinorUnits).toBeLessThan(estimate.highMinorUnits);
	});

	it('grows both bounds with distance', () => {
		const near = range(1000, 'DE');
		const far = range(20_000, 'DE');
		expect(far.lowMinorUnits).toBeGreaterThan(near.lowMinorUnits);
		expect(far.highMinorUnits).toBeGreaterThan(near.highMinorUnits);
	});

	it('at zero distance, the range collapses to the flag-down fee alone', () => {
		const estimate = range(0, 'ES');
		const card = TAXI_RATE_TABLE.ES;
		expect(estimate.lowMinorUnits).toBe(card.flagDownMinorUnits[0]);
		expect(estimate.highMinorUnits).toBe(card.flagDownMinorUnits[1]);
	});

	/**
	 * Issue #246. Production quoted the Gatwick-to-London-Backpackers transfer at
	 * £268.75-£430.90, against the €173.00 BVC-to-LGW flight it connects to. The GB card is
	 * £2.80-£4.50 per kilometre, back-calculated from "a London 5km fare comparison", and
	 * 300 + 280 × 94.9 is £268.72 to the penny.
	 *
	 * Measured on the app's own router (routing.openstreetmap.de/routed-car) 2026-09-05:
	 *   Kings Cross to Waterloo    5.1 km   13 min   23 km/h
	 *   LGW to London Backpackers  94.9 km  76 min   75 km/h
	 * The first is the ride the card was measured on. The second is nineteen times its
	 * distance at three times its speed, and a per-km figure that blends the meter's time
	 * and distance halves at 23 km/h does not describe it.
	 */
	it('refuses to price a ride past the range its rate cards were measured on', () => {
		const result = estimateTaxiFare(94_900, 'GB');

		expect(result.kind).toBe('out-of-range');
		expect(result).not.toHaveProperty('lowMinorUnits');
		expect(result).not.toHaveProperty('highMinorUnits');
		if (result.kind !== 'out-of-range') throw new Error('unreachable');
		expect(result.distanceKm).toBeCloseTo(94.9, 1);
		expect(result.ratedUpToKm).toBe(MAX_RATED_TAXI_DISTANCE_KM);
		// Still says which card it would have used and where that card came from, because
		// "we will not guess" is more useful with the reason attached.
		expect(result.countryCode).toBe('GB');
		expect(result.citation).toContain('London');
	});

	it('still prices the city ride its worst card was calibrated on', () => {
		// The GB citation's own reference point: roughly $23 for 5 km in London. The card
		// has to keep reproducing it, or the refusal above has thrown away a working answer
		// rather than a broken one.
		const estimate = range(5100, 'GB');
		expect(estimate.lowMinorUnits).toBe(1728);
		expect(estimate.highMinorUnits).toBe(2675);
	});

	it('refuses at the same distance for every country, including the fallback card', () => {
		const overBy100m = MAX_RATED_TAXI_DISTANCE_KM * 1000 + 100;
		for (const countryCode of [...Object.keys(TAXI_RATE_TABLE), 'ZZ']) {
			expect(estimateTaxiFare(overBy100m, countryCode).kind, countryCode).toBe('out-of-range');
			expect(estimateTaxiFare(MAX_RATED_TAXI_DISTANCE_KM * 1000, countryCode).kind, countryCode).toBe(
				'estimate'
			);
		}
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
