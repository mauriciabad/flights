import { describe, expect, it } from 'vitest';
import type { Duration, Itinerary, Transfer, TransferMode } from './index';
import { costIsUnknown, unpricedTransferLegs, walkedTransferLegs } from './index';

function transfer(mode: TransferMode, price?: Transfer['price']): Transfer {
	return { mode, duration: 20 as Duration, legs: [], price };
}

/** Only the four legs `unpricedTransferLegs` reads, which is all it takes. */
function legs(overrides: Partial<Pick<Itinerary, 'transferToOriginAirport' | 'transferToHotel' | 'transferToConnectionAirport' | 'transferToDestinationLocation'>>) {
	return {
		transferToOriginAirport: undefined,
		transferToHotel: undefined,
		transferToConnectionAirport: undefined,
		transferToDestinationLocation: undefined,
		...overrides
	};
}

describe('costIsUnknown', () => {
	it('is false for a walk, because walking is free and this app knows it', () => {
		// Issue #119 settled this distinction for the timeline's own note and issue #204
		// applies it to every total: an absent price on a walk is a fact, and an absent
		// price on a taxi is a gap in what a provider told us. Collapsing them is how a
		// 40km taxi came to be totalled at zero.
		expect(costIsUnknown(transfer('walk'))).toBe(false);
	});

	it('is true for every other mode a provider left unpriced', () => {
		expect(costIsUnknown(transfer('taxi'))).toBe(true);
		expect(costIsUnknown(transfer('drive'))).toBe(true);
		expect(costIsUnknown(transfer('transit'))).toBe(true);
	});

	it('is false as soon as a provider does quote a fare', () => {
		expect(costIsUnknown(transfer('taxi', { minorUnits: 4500, currency: 'EUR' }))).toBe(false);
	});

	it('treats a quoted zero as a quote, not as a gap', () => {
		// A provider that says a leg costs nothing has told us something. Reading that as
		// "unknown" would charge a ranking for an answer it actually has.
		expect(costIsUnknown(transfer('transit', { minorUnits: 0, currency: 'EUR' }))).toBe(false);
	});
});

describe('unpricedTransferLegs', () => {
	it('returns nothing when every leg is walked or priced', () => {
		expect(
			unpricedTransferLegs(
				legs({
					transferToHotel: transfer('walk'),
					transferToConnectionAirport: transfer('taxi', { minorUnits: 3000, currency: 'EUR' })
				})
			)
		).toEqual([]);
	});

	it('returns nothing for a trip with no ground legs at all', () => {
		expect(unpricedTransferLegs(legs({}))).toEqual([]);
	});

	it('names the legs in the order the trip happens', () => {
		const found = unpricedTransferLegs(
			legs({
				transferToDestinationLocation: transfer('taxi'),
				transferToHotel: transfer('taxi'),
				transferToOriginAirport: transfer('transit'),
				transferToConnectionAirport: transfer('drive')
			})
		);

		expect(found.map((entry) => entry.leg)).toEqual([
			'transferToOriginAirport',
			'transferToHotel',
			'transferToConnectionAirport',
			'transferToDestinationLocation'
		]);
	});

	it('hands back each leg itself, so a caller can charge it without a second lookup', () => {
		const taxi = transfer('taxi');
		const found = unpricedTransferLegs(legs({ transferToHotel: taxi }));

		expect(found).toEqual([{ leg: 'transferToHotel', transfer: taxi }]);
	});

	it('counts the two connection-side legs separately', () => {
		// "The airport run, both ways" and "one leg of four" are different sizes of hole,
		// and the card prints which.
		const found = unpricedTransferLegs(
			legs({ transferToHotel: transfer('taxi'), transferToConnectionAirport: transfer('taxi') })
		);
		expect(found).toHaveLength(2);
	});
});

describe('walkedTransferLegs', () => {
	it('names the legs this trip walks, in the order the trip happens', () => {
		expect(
			walkedTransferLegs(
				legs({
					transferToDestinationLocation: transfer('walk'),
					transferToHotel: transfer('taxi'),
					transferToOriginAirport: transfer('walk')
				})
			)
		).toEqual(['transferToOriginAirport', 'transferToDestinationLocation']);
	});

	it('is exactly the legs `unpricedTransferLegs` leaves out, for an unpriced trip', () => {
		// The two halves of `costIsUnknown` partition the ground legs a trip actually has.
		// Measured on production 2026-09-05: three taxis and one walk read as "Ground, 3
		// rides", and the walk was in neither list the receipt could ask for.
		const all = legs({
			transferToOriginAirport: transfer('walk'),
			transferToHotel: transfer('taxi'),
			transferToConnectionAirport: transfer('taxi'),
			transferToDestinationLocation: transfer('taxi')
		});

		expect(walkedTransferLegs(all)).toEqual(['transferToOriginAirport']);
		expect(unpricedTransferLegs(all).map((entry) => entry.leg)).toEqual([
			'transferToHotel',
			'transferToConnectionAirport',
			'transferToDestinationLocation'
		]);
	});

	it('returns nothing for a trip with no ground legs at all', () => {
		// Which is a different answer from "every leg is walked", and the receipt prints
		// the difference: no ground to speak of against ground that costs nothing.
		expect(walkedTransferLegs(legs({}))).toEqual([]);
	});

	it('leaves out a walk somebody put a price on', () => {
		// Nothing produces one, and if a provider ever quotes a shuttle as a walk its money
		// belongs in the priced total rather than in a list that claims these legs are free.
		expect(
			walkedTransferLegs(legs({ transferToHotel: transfer('walk', { minorUnits: 200, currency: 'EUR' }) }))
		).toEqual([]);
	});
});
