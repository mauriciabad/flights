import { describe, expect, it } from 'vitest';
import { estimateTaxiFare, MAX_RATED_TAXI_DISTANCE_KM, TAXI_RATE_TABLE } from './taxi-rate-table';
import type { FareRange } from '../../domain';

/** Narrows to the priced answer, so a test about the numbers fails loudly rather than
 * silently reading `undefined` off the refusal. */
function range(distanceMeters: number, countryCode: string): FareRange {
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

describe('putting the estimate in the traveller\'s currency (issue #339)', () => {
	/** The owner's own reading: a UK ride on a trip he asked for in euros. */
	function gbRideInEuros(): FareRange {
		const result = estimateTaxiFare(10_700, 'GB', 'EUR');
		if (result.kind !== 'estimate') throw new Error('expected a fare range');
		return result;
	}

	it('prints the traveller\'s currency and keeps the rate card\'s own range beside it', () => {
		const converted = gbRideInEuros();
		const unconverted = range(10_700, 'GB');

		expect(converted.currency).toBe('EUR');
		expect(converted.converted?.from).toBe('GBP');
		// The source survives the conversion rather than being spent by it, which is what
		// lets the receipt say what the driver actually charges. Byte-identical to the
		// figures the rate card produces with no display currency asked for.
		expect(converted.converted?.fromLowMinorUnits).toBe(unconverted.lowMinorUnits);
		expect(converted.converted?.fromHighMinorUnits).toBe(unconverted.highMinorUnits);
	});

	it('converts both bounds or neither, so the range never mixes two currencies', () => {
		const converted = gbRideInEuros();
		const unconverted = range(10_700, 'GB');

		expect(converted.lowMinorUnits).not.toBe(unconverted.lowMinorUnits);
		expect(converted.highMinorUnits).not.toBe(unconverted.highMinorUnits);
		expect(converted.lowMinorUnits).toBeLessThan(converted.highMinorUnits);
		// Sterling is worth more than a euro, so the euro figures are the larger pair. A
		// conversion applied upside down would still produce a plausible-looking range.
		expect(converted.lowMinorUnits).toBeGreaterThan(unconverted.lowMinorUnits);
	});

	it('leaves the estimate alone when the rate card is already in the picked currency', () => {
		// A Spanish ride for a traveller paying in euros. Converting EUR to EUR would be a
		// no-op with a "converted from EUR" line under it, which is noise claiming to be
		// provenance.
		const spanish = estimateTaxiFare(5000, 'ES', 'EUR');
		expect(spanish).toEqual(range(5000, 'ES'));
		expect((spanish as FareRange).converted).toBeUndefined();
	});

	it('keeps the rate card\'s currency when no rate exists for the pair', () => {
		// A currency the ECB does not publish, which `keys/storage.ts` will happily keep out
		// of an imported key file. Pounds a driver really charges beat euros crossed at a
		// rate nobody has, so this degrades to the pre-#339 behaviour rather than to a blank.
		const noRate = estimateTaxiFare(10_700, 'GB', 'CVE');
		expect(noRate).toEqual(range(10_700, 'GB'));
		expect((noRate as FareRange).converted).toBeUndefined();
	});

	it('never converts the over-distance refusal, which carries no money to convert', () => {
		const refusal = estimateTaxiFare(94_900, 'GB', 'EUR');
		expect(refusal.kind).toBe('out-of-range');
		expect(refusal).toEqual(estimateTaxiFare(94_900, 'GB'));
	});

	it('converts the fallback card too, so an unrated country still reads in the right currency', () => {
		// The fallback card is denominated in EUR, so a traveller paying in pounds was
		// reading euros for a country with no card of its own. Same defect, different row.
		const fallback = estimateTaxiFare(8000, 'ZZ', 'GBP');
		if (fallback.kind !== 'estimate') throw new Error('expected a fare range');
		expect(fallback.rateSource).toBe('fallback');
		expect(fallback.currency).toBe('GBP');
		expect(fallback.converted?.from).toBe('EUR');
	});
});
