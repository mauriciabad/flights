import { describe, expect, it } from 'vitest';
import type { Duration, Itinerary } from '../domain';
import { sumMoney } from '../algorithm/build';
import { makeItinerary } from '../results/test-support';
import { ALL_METRIC_IDS, CARD_METRIC_IDS, itineraryMetrics, priceBreakdown } from './itinerary-metrics';

function valueOf(itinerary: Itinerary, id: (typeof ALL_METRIC_IDS)[number]): string {
	return itineraryMetrics(itinerary, [id])[0]!.value;
}

function withoutStay(itinerary: Itinerary): Itinerary {
	const { stay: _stay, ...rest } = itinerary;
	return rest as Itinerary;
}

describe('itineraryMetrics', () => {
	it('returns exactly the figures asked for, in the order asked for', () => {
		const metrics = itineraryMetrics(makeItinerary({}), CARD_METRIC_IDS);
		expect(metrics.map((metric) => metric.id)).toEqual([...CARD_METRIC_IDS]);
	});

	it('reads a night count off the schedule, never off whether a bed was priced', () => {
		// Issues #105/#108/#140. One of the three hand-written copies of these figures
		// used to print "No stay priced" in this slot, which is the mistake a shared
		// builder exists to make impossible: a 12-night stopover is 12 nights with no stay
		// provider configured, which is every first-time visitor's state.
		const priced = makeItinerary({ nightsInConnection: 12 });
		const unpriced = withoutStay(priced);
		expect(valueOf(priced, 'nights')).toBe('12');
		expect(valueOf(unpriced, 'nights')).toBe('12');
	});

	it('keeps the missing-bed caveat on the price, not under the night count', () => {
		// The count is a fact about the schedule; the missing bed is a fact about the
		// price. Noting it under both put the same warning twice on one card.
		const unpriced = withoutStay(makeItinerary({ nightsInConnection: 3 }));
		const [nights] = itineraryMetrics(unpriced, ['nights']);
		expect(nights!.value).toBe('3');
		expect(nights!.note).toBeUndefined();
		expect(itineraryMetrics(unpriced, ['total-price'])[0]!.note).toBe('excludes an unpriced stay');
	});

	it('says nothing about a missing bed on a same-day connection, which has none to miss', () => {
		// Issue #140: warning here would invent a cost the trip never had.
		const sameDay = withoutStay(makeItinerary({ nightsInConnection: 0 }));
		expect(itineraryMetrics(sameDay, ['nights'])[0]!.note).toBeUndefined();
		expect(itineraryMetrics(sameDay, ['total-price'])[0]!.note).toBeUndefined();
	});

	it('flags a total that excludes an unpriced bed for a stopover that does spend a night', () => {
		const overnight = withoutStay(makeItinerary({ nightsInConnection: 2 }));
		expect(itineraryMetrics(overnight, ['total-price'])[0]!.note).toBe('excludes an unpriced stay');
	});

	it('reads a multi-day total in days rather than as a three-digit hour count', () => {
		expect(valueOf(makeItinerary({ totalMinutes: 4560 }), 'total-time')).toBe('3d 4h');
		expect(valueOf(makeItinerary({ freeTimeMinutes: 4320 }), 'free-time')).toBe('3d');
	});

	it('colours the stopover figures with the token reserved for the free city', () => {
		const metrics = itineraryMetrics(makeItinerary({}), ALL_METRIC_IDS);
		const tones = Object.fromEntries(metrics.map((metric) => [metric.id, metric.tone]));
		expect(tones.nights).toBe('stopover');
		expect(tones['free-time']).toBe('stopover');
		expect(tones['total-price']).toBe('primary');
		expect(tones['in-flight']).toBe('default');
	});
});

describe('priceBreakdown', () => {
	it('adds up to exactly the total it is explaining', () => {
		// The reason this reuses the builder's own `scaleFareForParty`/`sumMoney` instead of
		// re-deriving the arithmetic: a fare scales to the party by that offer's own
		// declared `priceScope` (issue #109), so a hand-rolled split would print subtotals
		// that do not add up to the number printed above them.
		for (const itinerary of [
			makeItinerary({ nightsInConnection: 3 }),
			makeItinerary({ nightsInConnection: 0 }),
			makeItinerary({ nightsInConnection: 2, travellers: 3 })
		]) {
			const breakdown = priceBreakdown(itinerary);
			const summed = sumMoney(breakdown.parts[0]!.money, ...breakdown.parts.slice(1).map((part) => part.money));
			expect(summed).toEqual(breakdown.total);
		}
	});

	it('leaves the bed out entirely when nothing priced one, and says so separately', () => {
		const unpriced = withoutStay(makeItinerary({ nightsInConnection: 4 }));
		const breakdown = priceBreakdown(unpriced);
		expect(breakdown.parts.map((part) => part.id)).toEqual(['flights']);
		expect(breakdown.missingStay).toBe(true);
	});

	it('does not call a same-day connection incomplete', () => {
		const sameDay = withoutStay(makeItinerary({ nightsInConnection: 0 }));
		expect(priceBreakdown(sameDay).missingStay).toBe(false);
	});

	it('says how many nights the bed line covers, since the nightly rate alone does not', () => {
		const breakdown = priceBreakdown(makeItinerary({ nightsInConnection: 1 }));
		const stay = breakdown.parts.find((part) => part.id === 'stay');
		expect(stay?.detail).toBe('1 night');
		expect(priceBreakdown(makeItinerary({ nightsInConnection: 5 })).parts.find((p) => p.id === 'stay')?.detail).toBe(
			'5 nights'
		);
	});

	it('omits a ground line while no transfer provider prices one', () => {
		// domain/transfer.ts: no adapter populates `Transfer.price` today. A zero row here
		// would read as "the transfers are free", which is a claim nobody measured.
		expect(priceBreakdown(makeItinerary({})).parts.some((part) => part.id === 'ground')).toBe(false);
	});

	// Issue #204 --------------------------------------------------------------

	it('counts nothing unpriced when every leg is walked', () => {
		// `makeItinerary`'s default legs are walks, so the total really is complete here.
		// This is the case the count has to leave alone: an absent ground line means "free
		// on foot" as often as it means "nobody said", and blurring them was the bug.
		expect(priceBreakdown(makeItinerary({})).unpricedTransferCount).toBe(0);
	});

	it('counts each ground leg nobody quoted a fare for', () => {
		const taxi = { mode: 'taxi' as const, duration: 30 as Duration, legs: [] };
		const byTaxi = { ...makeItinerary({}), transferToHotel: taxi, transferToConnectionAirport: taxi };
		expect(priceBreakdown(byTaxi).unpricedTransferCount).toBe(2);
	});

	it('warns about the bed and the rides in one caveat, not two', () => {
		// Two warning chips stacked under one number read as two separate problems when
		// they are one: the total is a floor.
		const taxi = { mode: 'taxi' as const, duration: 30 as Duration, legs: [] };
		const both = { ...withoutStay(makeItinerary({ nightsInConnection: 3 })), transferToHotel: taxi };
		expect(itineraryMetrics(both, ['total-price'])[0]!.note).toBe('excludes a bed and ground transport');
	});

	it('names only the omission that actually applies', () => {
		const taxi = { mode: 'taxi' as const, duration: 30 as Duration, legs: [] };
		const groundOnly = { ...makeItinerary({ nightsInConnection: 3 }), transferToHotel: taxi };
		expect(itineraryMetrics(groundOnly, ['total-price'])[0]!.note).toBe('excludes unpriced ground transport');

		const bedOnly = withoutStay(makeItinerary({ nightsInConnection: 3 }));
		expect(itineraryMetrics(bedOnly, ['total-price'])[0]!.note).toBe('excludes an unpriced stay');
	});

	it('counts the rides to a bed nothing could route to', () => {
		// Issue #211: `resources.ts` now keeps a priced bed whose transfers no provider
		// could find. The bed's price is real and belongs in the total; getting to it and
		// back is two rides whose cost is completely unknown, which is a bigger hole than an
		// unquoted fare, not a smaller one. A total that read as complete here would be the
		// same overstatement issue #204 exists to remove, in a new shape.
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...unrouted } = makeItinerary({
			nightsInConnection: 3
		});
		const breakdown = priceBreakdown(unrouted as Itinerary);

		expect(breakdown.unpricedTransferCount).toBe(2);
		expect(itineraryMetrics(unrouted as Itinerary, ['total-price'])[0]!.note).toBe(
			'excludes unpriced ground transport'
		);
	});

	it('does not invent rides for a trip that has no bed to reach', () => {
		// Without a stay there is no hotel leg to have failed, so the missing legs are not a
		// routing failure and counting them would manufacture a caveat.
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...bedless } = withoutStay(
			makeItinerary({ nightsInConnection: 3 })
		);
		expect(priceBreakdown(bedless as Itinerary).unpricedTransferCount).toBe(0);
	});

	it('does not invent rides for a same-day connection either', () => {
		// Issue #140's gate. Nobody leaves the airport on a same-day connection, so a hotel
		// leg it does not have is not a leg that failed to route.
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...sameDay } = makeItinerary({
			nightsInConnection: 0
		});
		expect(priceBreakdown(sameDay as Itinerary).unpricedTransferCount).toBe(0);
		expect(itineraryMetrics(sameDay as Itinerary, ['total-price'])[0]!.note).toBeUndefined();
	});

	it('leaves a fully-known total with no caveat at all', () => {
		// A same-day connection walked at both ends really is completely priced, and
		// warning about it would invent a cost the trip never had (issue #140).
		expect(itineraryMetrics(makeItinerary({ nightsInConnection: 0 }), ['total-price'])[0]!.note).toBeUndefined();
	});
});
