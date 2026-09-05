import { describe, expect, it } from 'vitest';
import { transferIconKind, VEHICLE_FAMILY } from './mode-icon';
import { TRANSIT_MODE_LABELS } from '$lib/providers/transfers/transitous-mapper';
import type { Duration, Transfer, TransferLeg } from '$lib/domain';

function ride(vehicle: string | undefined): TransferLeg {
	return { mode: 'transit', vehicle, duration: 20 as Duration };
}

const WALK: TransferLeg = { mode: 'walk', duration: 6 as Duration };

function transit(...legs: TransferLeg[]): Transfer {
	return { mode: 'transit', duration: 40 as Duration, legs };
}

describe('transferIconKind', () => {
	it('gives the three unambiguous modes their own glyph', () => {
		for (const mode of ['walk', 'taxi', 'drive'] as const) {
			expect(transferIconKind({ mode, duration: 20 as Duration, legs: [] })).toBe(mode);
		}
	});

	it('names the vehicle when every ride agrees on one family', () => {
		expect(transferIconKind(transit(WALK, ride('Train'), WALK))).toBe('transit-rail');
		expect(transferIconKind(transit(ride('Ferry')))).toBe('transit-ferry');
		expect(transferIconKind(transit(ride('Bus'), ride('Coach')))).toBe('transit');
	});

	it('treats a metro and a tram as rail, which is what they run on', () => {
		expect(transferIconKind(transit(ride('Metro'), ride('Tram')))).toBe('transit-rail');
		expect(transferIconKind(transit(ride('Night train')))).toBe('transit-rail');
	});

	it('refuses to pick a winner when the rides disagree', () => {
		// `itinerary-timeline-format.ts` writes "Bus, then metro" for this journey rather
		// than choosing one. Neither vehicle is the truth about it, so neither gets the mark.
		expect(transferIconKind(transit(ride('Bus'), ride('Metro')))).toBe('transit');
	});

	it('stays generic when a provider did not name a vehicle', () => {
		// A `Transfer` cached before `TransferLeg.vehicle` existed reaches this with every
		// vehicle undefined, and so does any future adapter that does not name its vehicles.
		expect(transferIconKind(transit(ride(undefined)))).toBe('transit');
		expect(transferIconKind(transit(ride('Train'), ride(undefined)))).toBe('transit');
	});

	it('stays generic for a vehicle no icon in this set depicts', () => {
		// Substituting a train for a funicular would be the small dishonesty #322 names.
		expect(transferIconKind(transit(ride('Funicular')))).toBe('transit');
		expect(transferIconKind(transit(ride('Cable car')))).toBe('transit');
		expect(transferIconKind(transit(ride('Transit')))).toBe('transit');
	});

	it('stays generic when the transfer is nothing but walking to a stop', () => {
		expect(transferIconKind(transit(WALK, WALK))).toBe('transit');
	});

	/**
	 * The lint that keeps the two tables honest. `transitous-mapper.ts` is the only writer of
	 * `TransferLeg.vehicle`, so a mode label added there without a decision in
	 * `VEHICLE_FAMILY` would silently start rendering as a bus. Adding the label to
	 * KNOWINGLY_GENERIC is a decision; forgetting it is this failing.
	 */
	it('has a decision recorded for every vehicle word the mapper can produce', () => {
		const KNOWINGLY_GENERIC = ['Cable car', 'Gondola', 'Funicular'];
		const undecided = [...new Set(Object.values(TRANSIT_MODE_LABELS))].filter(
			(label) => VEHICLE_FAMILY[label] === undefined && !KNOWINGLY_GENERIC.includes(label)
		);
		expect(undecided, 'transitous-mapper can produce these, and mode-icon.ts does not say what they look like').toEqual(
			[]
		);
	});
});
