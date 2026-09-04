import { describe, expect, it } from 'vitest';
import type { Itinerary } from '../domain';
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

	it('adds the missing-bed caveat alongside the night count, never instead of it', () => {
		const unpriced = withoutStay(makeItinerary({ nightsInConnection: 3 }));
		const [nights] = itineraryMetrics(unpriced, ['nights']);
		expect(nights!.value).toBe('3');
		expect(nights!.note).toBe('no bed priced');
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
});
