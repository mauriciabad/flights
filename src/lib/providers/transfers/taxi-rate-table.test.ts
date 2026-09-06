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

describe('estimateTaxiFare, priced for the party (issue #344)', () => {
	/** Narrows to the priced answer for a named party, the way `range` does for a lone one. */
	function partyRange(distanceMeters: number, countryCode: string, travellers: number): FareRange {
		const result = estimateTaxiFare(distanceMeters, countryCode, undefined, travellers);
		if (result.kind !== 'estimate') throw new Error('expected a fare range');
		return result;
	}

	it('leaves a lone traveller exactly where it found them', () => {
		// The car's fare, the party's fare and the head's share are one number, and printing
		// it three times says nothing. Byte-identical to the pre-#344 answer.
		expect(partyRange(5000, 'ES', 1)).toEqual(range(5000, 'ES'));
		expect(partyRange(5000, 'ES', 1).party).toBeUndefined();
	});

	it('prices one car for four and divides it four ways', () => {
		const alone = range(5000, 'ES');
		const four = partyRange(5000, 'ES', 4);

		// Four people fit in one saloon, so the party pays what one traveller would.
		expect(four.lowMinorUnits).toBe(alone.lowMinorUnits);
		expect(four.highMinorUnits).toBe(alone.highMinorUnits);
		expect(four.party).toEqual({
			basis: 'per-vehicle',
			people: 4,
			vehicles: 1,
			perVehicleLowMinorUnits: alone.lowMinorUnits,
			perVehicleHighMinorUnits: alone.highMinorUnits,
			perPersonLowMinorUnits: Math.round(alone.lowMinorUnits / 4),
			perPersonHighMinorUnits: Math.round(alone.highMinorUnits / 4)
		});
	});

	it('the issue\'s own arithmetic: a party of four reads a quarter each', () => {
		const four = partyRange(5000, 'ES', 4);
		if (four.party?.basis !== 'per-vehicle') throw new Error('expected a per-vehicle party');
		// €7.83-€10.88 each against a €31.30-€43.50 car, which is the comparison the owner
		// asked for and the one the app could not previously express.
		expect(four.party.perPersonLowMinorUnits * 4).toBeCloseTo(four.lowMinorUnits, -1);
		expect(four.party.perPersonLowMinorUnits).toBeLessThan(four.lowMinorUnits);
	});

	it('counts a second car for a party that does not fit in one, and splits both', () => {
		const alone = range(5000, 'ES');
		const five = partyRange(5000, 'ES', 5);

		expect(five.lowMinorUnits).toBe(alone.lowMinorUnits * 2);
		expect(five.highMinorUnits).toBe(alone.highMinorUnits * 2);
		if (five.party?.basis !== 'per-vehicle') throw new Error('expected a per-vehicle party');
		expect(five.party.vehicles).toBe(2);
		// A fifth of two cars, never a fifth of one. Getting this wrong is the direction that
		// flatters the taxi, which is the whole reason the car count exists.
		expect(five.party.perPersonLowMinorUnits).toBe(Math.round((alone.lowMinorUnits * 2) / 5));
		expect(five.party.perPersonLowMinorUnits).toBeGreaterThan(
			Math.round(alone.lowMinorUnits / 5)
		);
	});

	it('keeps the card\'s own per-vehicle figures alongside the party total', () => {
		const six = partyRange(8000, 'DE', 6);
		if (six.party?.basis !== 'per-vehicle') throw new Error('expected a per-vehicle party');
		const alone = range(8000, 'DE');
		// What one driver's meter reads, so nothing has to divide the party total back out to
		// find it and show this function's rounding as though it were the tariff.
		expect(six.party.perVehicleLowMinorUnits).toBe(alone.lowMinorUnits);
		expect(six.party.perVehicleHighMinorUnits).toBe(alone.highMinorUnits);
		expect(six.party.vehicles).toBe(2);
	});

	it('refuses to divide a card whose basis nobody checked', () => {
		// The fallback card stands for a country with no tariff read, and a shared taxi sold
		// by the seat is ordinary in much of what it covers. So the party size is carried and
		// the arithmetic is not done.
		const four = partyRange(5000, 'ZZ', 4);
		expect(four.rateSource).toBe('fallback');
		expect(four.party).toEqual({ basis: 'unknown', people: 4 });
		// And the bounds stay one car's, unmultiplied.
		expect(four.lowMinorUnits).toBe(range(5000, 'ZZ').lowMinorUnits);
	});

	it('carries the party through a currency conversion, or converts nothing at all', () => {
		const four = estimateTaxiFare(10_700, 'GB', 'EUR', 4);
		if (four.kind !== 'estimate') throw new Error('expected a fare range');
		if (four.party?.basis !== 'per-vehicle') throw new Error('expected a per-vehicle party');
		const sterling = partyRange(10_700, 'GB', 4);
		if (sterling.party?.basis !== 'per-vehicle') throw new Error('expected a per-vehicle party');

		expect(four.currency).toBe('EUR');
		// Six figures in euros or six in pounds. A party total in one and a per-head share in
		// the other is not a comparison, it is two numbers that happen to be adjacent.
		expect(four.party.perPersonLowMinorUnits).toBeGreaterThan(sterling.party.perPersonLowMinorUnits);
		expect(four.party.perVehicleLowMinorUnits).toBeGreaterThan(sterling.party.perVehicleLowMinorUnits);
		expect(four.converted?.fromLowMinorUnits).toBe(sterling.lowMinorUnits);
	});

	it('leaves the party out of a currency it cannot cross into', () => {
		// Same degradation #339 chose: the rate card's own currency beats a figure crossed at
		// a rate nobody has, and the split has to go back with it rather than stand in pounds
		// under a total in escudos.
		const noRate = estimateTaxiFare(10_700, 'GB', 'CVE', 4);
		expect(noRate).toEqual(partyRange(10_700, 'GB', 4));
	});

	it('ignores the party on the over-distance refusal, which has no fare to split', () => {
		const refusal = estimateTaxiFare(94_900, 'GB', undefined, 4);
		expect(refusal.kind).toBe('out-of-range');
		expect(refusal).toEqual(estimateTaxiFare(94_900, 'GB'));
	});

	it('never lets a nonsense party size invent a discount', () => {
		// A zero or a fraction reaching this from a hand-edited URL must price a whole car,
		// not a fraction of one, and must not divide by zero.
		expect(estimateTaxiFare(5000, 'ES', undefined, 0)).toEqual(range(5000, 'ES'));
		expect(estimateTaxiFare(5000, 'ES', undefined, 1.5)).toEqual(range(5000, 'ES'));
	});
});

describe('the rate cards themselves', () => {
	it('every country card says it prices the car, and the fallback says it does not know', () => {
		// Issue #344 asked for this to be checked per country rather than assumed. If a card
		// arrives whose tariff prices a seat, this test is where that has to be stated.
		for (const [countryCode, card] of Object.entries(TAXI_RATE_TABLE)) {
			expect(card.basis, `${countryCode} must declare what it prices`).toBe('per-vehicle');
		}
		const fallback = estimateTaxiFare(5000, 'ZZ', undefined, 2);
		if (fallback.kind !== 'estimate') throw new Error('expected a fare range');
		expect(fallback.party?.basis).toBe('unknown');
	});

	it('the fallback card contains every country card, in euros, at every rated distance', () => {
		// The fallback's whole claim is that it spans the twelve cards, and for a long time it did
		// not. Its four figures were copied off cards denominated in GBP, CHF, SEK and CZK as
		// though a minor unit meant the same thing in each, so it topped out at €22.00 on a 5 km
		// ride against Switzerland's €34.02. Asserting the claim is cheaper than restating it in a
		// comment, and it is the only thing standing between a thirteenth country and the same
		// mistake. Add one outside this span and this fails with the figure that would fix it.
		for (const countryCode of Object.keys(TAXI_RATE_TABLE)) {
			for (let km = 0; km <= MAX_RATED_TAXI_DISTANCE_KM; km += 1) {
				const card = estimateTaxiFare(km * 1000, countryCode, 'EUR');
				const fallback = estimateTaxiFare(km * 1000, 'ZZ');
				if (card.kind !== 'estimate' || fallback.kind !== 'estimate') {
					throw new Error(`expected fare ranges for ${countryCode} at ${km}km`);
				}
				// A card that came back in its own currency because the ECB feed went stale would
				// otherwise be compared minor unit against minor unit, which is the bug itself.
				expect(card.currency, `${countryCode} at ${km}km did not convert to euros`).toBe('EUR');
				expect(
					fallback.lowMinorUnits,
					`fallback low is above ${countryCode}'s low at ${km}km`
				).toBeLessThanOrEqual(card.lowMinorUnits);
				expect(
					fallback.highMinorUnits,
					`fallback high is below ${countryCode}'s high at ${km}km`
				).toBeGreaterThanOrEqual(card.highMinorUnits);
			}
		}
	});
});
