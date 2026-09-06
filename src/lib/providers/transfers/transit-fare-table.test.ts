import { describe, expect, it } from 'vitest';
import {
	countTransitBoardings,
	estimateTransitFare,
	ratedUpToKm,
	TRANSIT_FARE_SLACK_KM,
	TRANSIT_FARE_TABLE
} from './transit-fare-table';
import type { FareRange } from '../../domain';

/** Narrows to the priced answer, so a test about the numbers fails loudly rather than
 * silently reading `undefined` off a refusal or off an airport nobody has a card for. */
function range(
	airportCode: string,
	straightLineKm = 5,
	boardings = 1,
	displayCurrency?: string,
	travellers?: number
): FareRange {
	const result = estimateTransitFare(airportCode, straightLineKm, boardings, displayCurrency, travellers);
	if (result?.kind !== 'estimate') {
		throw new Error(`expected a fare range for ${airportCode} over ${straightLineKm} km`);
	}
	return result;
}

describe('estimateTransitFare', () => {
	it('prices a covered airport from its own card and says where the figure came from', () => {
		const estimate = range('BCN');

		expect(estimate.currency).toBe('EUR');
		expect(estimate.countryCode).toBe('ES');
		expect(estimate.lowMinorUnits).toBe(290);
		expect(estimate.highMinorUnits).toBe(590);
		expect(estimate.citation).toContain('tmb.cat');
	});

	it('answers nothing at all for an airport nobody has read a tariff for', () => {
		// The refusal that matters most, and the one the owner will see at most airports.
		// `undefined` reaches `groundFare` as `'unquoted'` and the picker says "Price not
		// available", which is the app admitting it rather than guessing a fare.
		expect(estimateTransitFare('BVC', 5, 1)).toBeUndefined();
		expect(estimateTransitFare('PFO', 5, 1)).toBeUndefined();
		expect(estimateTransitFare('', 5, 1)).toBeUndefined();
	});

	it('never claims a dedicated card it does not have', () => {
		// `rateSource: 'fallback'` is the taxi table's word for a generic band standing in
		// for a country nobody read. This table has no such band, so nothing it produces
		// may wear that label.
		for (const code of Object.keys(TRANSIT_FARE_TABLE)) {
			expect(range(code).rateSource).toBe('country');
		}
	});

	it('refuses a journey that has left the fare area the ticket was sold for', () => {
		const card = TRANSIT_FARE_TABLE.BER;
		const limit = ratedUpToKm(card);
		const refusal = estimateTransitFare('BER', limit + 0.1, 1);

		expect(refusal?.kind).toBe('out-of-range');
		if (refusal?.kind !== 'out-of-range') throw new Error('expected the refusal');
		expect(refusal.ratedUpToKm).toBe(limit);
		expect(refusal.distanceKm).toBeCloseTo(limit + 0.1);
		// The card that would have answered is still named, so a screen can say which
		// ticket it declined to stretch rather than going quiet. Issue #246's rule.
		expect(refusal.citation).toBe(card.citation);
	});

	it('still prices a journey at the edge of what its card describes', () => {
		const limit = ratedUpToKm(TRANSIT_FARE_TABLE.BER);
		expect(range('BER', limit).lowMinorUnits).toBe(500);
	});

	it('derives the rated distance from the measured centre distance and the stated slack', () => {
		// Berlin's runway is 19.1 km from Mitte, so the ticket is rated to 20 km rounded up
		// plus the slack. Written out rather than recomputed with the same expression the
		// implementation uses, so a change to the rule has to be made deliberately here too.
		expect(ratedUpToKm({ centreKm: 19.1 })).toBe(20 + TRANSIT_FARE_SLACK_KM);
		expect(ratedUpToKm({ centreKm: 6.4 })).toBe(10 + TRANSIT_FARE_SLACK_KM);
		expect(ratedUpToKm({ centreKm: 20 })).toBe(20 + TRANSIT_FARE_SLACK_KM);
	});

	it('rejects a negative distance rather than returning a nonsensical estimate', () => {
		expect(() => estimateTransitFare('BCN', -1, 1)).toThrow(/non-negative/);
	});
});

describe('what a change of vehicle costs', () => {
	it('charges nothing extra where the ticket covers the whole journey', () => {
		// Prague sells 90 minutes with unlimited changes, so bus 119 plus two metro rides
		// is one ticket and the leg count is not an input to the fare.
		expect(range('PRG', 5, 1).lowMinorUnits).toBe(4600);
		expect(range('PRG', 5, 3).lowMinorUnits).toBe(4600);
		expect(range('PRG', 5, 3).highMinorUnits).toBe(5000);
	});

	it('charges one more ticket per extra vehicle where the network sells a ride', () => {
		// Budapest: a BKK single buys one vehicle. Bus 200E plus the M3 metro is two.
		expect(range('BUD', 5, 1).lowMinorUnits).toBe(50000);
		expect(range('BUD', 5, 2).lowMinorUnits).toBe(100000);
		expect(range('BUD', 5, 3).lowMinorUnits).toBe(150000);
		// And the dear end is the 100E airport shuttle plus the same extra singles.
		expect(range('BUD', 5, 2).highMinorUnits).toBe(300000);
	});

	it('adds the city ticket to a rail fare that stops at the station', () => {
		// Amsterdam: the NS fare ends at Amsterdam Centraal and GVB charges for the tram.
		expect(range('AMS', 5, 1).lowMinorUnits).toBe(550);
		expect(range('AMS', 5, 2).lowMinorUnits).toBe(890);
	});

	it('treats a journey with no boardings as one, never as free', () => {
		expect(range('AMS', 5, 0).lowMinorUnits).toBe(550);
		expect(countTransitBoardings([])).toBe(1);
		expect(countTransitBoardings([{ mode: 'walk' }, { mode: 'walk' }])).toBe(1);
	});

	it('counts vehicles and not walks, because the walk to the stop is free', () => {
		expect(countTransitBoardings([{ mode: 'walk' }, { mode: 'transit' }, { mode: 'walk' }])).toBe(1);
		expect(
			countTransitBoardings([
				{ mode: 'walk' },
				{ mode: 'transit' },
				{ mode: 'walk' },
				{ mode: 'transit' }
			])
		).toBe(2);
	});
});

describe('a ticket multiplies by the party (issue #407)', () => {
	it('leaves a lone traveller exactly where it found them', () => {
		const alone = range('BCN', 5, 1, undefined, 1);
		expect(alone.party).toBeUndefined();
		expect(alone.lowMinorUnits).toBe(290);
		expect(estimateTransitFare('BCN', 5, 1)).toEqual(alone);
	});

	it('charges four travellers four tickets, and says so', () => {
		const four = range('BCN', 5, 1, undefined, 4);

		expect(four.lowMinorUnits).toBe(290 * 4);
		expect(four.highMinorUnits).toBe(590 * 4);
		expect(four.party).toEqual({
			basis: 'per-person',
			people: 4,
			perPersonLowMinorUnits: 290,
			perPersonHighMinorUnits: 590
		});
	});

	it('multiplies rather than divides, which is the whole point of the basis', () => {
		// The taxi card divides one car between heads. This one does the opposite, and the
		// two used to be the same absent field. A party fare below one traveller's would be
		// the mistake `FareParty` exists to make impossible.
		const one = range('LIS', 5, 1, undefined, 1);
		const three = range('LIS', 5, 1, undefined, 3);
		expect(three.lowMinorUnits).toBeGreaterThan(one.lowMinorUnits);
		expect(three.lowMinorUnits).toBe(one.lowMinorUnits * 3);
	});

	it('never lets a nonsense party size invent a discount', () => {
		expect(range('LIS', 5, 1, undefined, 0).lowMinorUnits).toBe(190);
		expect(range('LIS', 5, 1, undefined, -4).lowMinorUnits).toBe(190);
		expect(range('LIS', 5, 1, undefined, 2.7).lowMinorUnits).toBe(380);
	});
});

describe("putting the ticket in the traveller's currency", () => {
	it("prints the traveller's currency and keeps the operator's own figures beside it", () => {
		const estimate = range('PRG', 5, 1, 'EUR');

		expect(estimate.currency).toBe('EUR');
		expect(estimate.converted?.from).toBe('CZK');
		expect(estimate.converted?.fromLowMinorUnits).toBe(4600);
		expect(estimate.converted?.fromHighMinorUnits).toBe(5000);
		expect(estimate.converted?.rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("leaves the card alone when it is already in the traveller's currency", () => {
		const estimate = range('BCN', 5, 1, 'EUR');
		expect(estimate.currency).toBe('EUR');
		expect(estimate.converted).toBeUndefined();
	});

	it('carries the per-person share through the conversion, or converts nothing at all', () => {
		const estimate = range('PRG', 5, 1, 'EUR', 3);

		expect(estimate.party?.basis).toBe('per-person');
		if (estimate.party?.basis !== 'per-person') throw new Error('expected a per-person party');
		// Six figures in one currency and none in another is the defect this guards: the
		// picker prints the party's fare and one head's on the same line.
		expect(estimate.party.perPersonLowMinorUnits).toBeLessThan(4600);
		expect(estimate.lowMinorUnits).toBeGreaterThan(estimate.party.perPersonLowMinorUnits);
	});

	it('never converts the out-of-range refusal, which carries no money to convert', () => {
		const refusal = estimateTransitFare('PRG', 1000, 1, 'EUR');
		expect(refusal?.kind).toBe('out-of-range');
		expect(refusal).not.toHaveProperty('currency');
	});
});

describe('the fare cards themselves', () => {
	it('every card cites an operator and the day it was read', () => {
		// AGENTS.md, and the reason this table is allowed to exist at all: an uncited fare
		// is worse than an empty row, because the next reader cannot tell a researched
		// number from a remembered one.
		for (const [code, card] of Object.entries(TRANSIT_FARE_TABLE)) {
			expect(card.citation, code).toMatch(/read 2\d{3}-\d{2}-\d{2}/);
			expect(card.citation.length, code).toBeGreaterThan(120);
		}
	});

	it('every card has a low bound at or below its high bound, journey and onward alike', () => {
		for (const [code, card] of Object.entries(TRANSIT_FARE_TABLE)) {
			expect(card.journeyMinorUnits[0], code).toBeLessThanOrEqual(card.journeyMinorUnits[1]);
			expect(card.journeyMinorUnits[0], code).toBeGreaterThan(0);
			if (card.onwardMinorUnits) {
				expect(card.onwardMinorUnits[0], code).toBeLessThanOrEqual(card.onwardMinorUnits[1]);
				expect(card.onwardMinorUnits[0], code).toBeGreaterThan(0);
			}
		}
	});

	it('every card names a city, a country and a plausible distance to it', () => {
		for (const [code, card] of Object.entries(TRANSIT_FARE_TABLE)) {
			expect(card.city.length, code).toBeGreaterThan(2);
			expect(card.countryCode, code).toMatch(/^[A-Z]{2}$/);
			expect(card.centreKm, code).toBeGreaterThan(0);
			// Past this an airport is not serving the city on an urban ticket, and the card
			// is describing a journey its tariff was never sold for.
			expect(card.centreKm, code).toBeLessThan(60);
		}
	});

	it('is keyed by upper-case IATA codes, since that is what an itinerary carries', () => {
		for (const code of Object.keys(TRANSIT_FARE_TABLE)) {
			expect(code).toMatch(/^[A-Z]{3}$/);
		}
	});
});
