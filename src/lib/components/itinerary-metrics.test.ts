import { describe, expect, it } from 'vitest';
import type { Duration, Itinerary, Money, Transfer } from '../domain';
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
	});

	// Issue #228, the owner: "showing the duration as '2d 15h free' on the free days is
	// misleading and wrong. we should display it in full days count". So this cell counts
	// whole days off the real window, and no longer reads `times.free` at all.
	it('counts free time in whole days, off the window rather than off its duration', () => {
		const overFourNights = makeItinerary({
			freeTimeStart: '2026-10-09T21:10:00',
			freeTimeEnd: '2026-10-13T09:05:00'
		});
		expect(valueOf(overFourNights, 'free-time')).toBe('3 full days');
	});

	it('says "No full days" for a stopover that gives none, plural and never "0"', () => {
		// A mandatory one-night connection: in at 9:55pm, out at 4:55am. Seven hours of
		// free time and not one whole day, which "7h" flattered and this does not.
		const oneNight = makeItinerary({
			freeTimeStart: '2026-10-08T21:55:00',
			freeTimeEnd: '2026-10-09T04:55:00'
		});
		expect(valueOf(oneNight, 'free-time')).toBe('No full days');
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
			// Issue #305 moved the bed out of `parts` and into its own group, so the receipt
			// adds up across both. Every row on screen is still in this sum: that is the
			// property the split must not break.
			const amounts = [
				...breakdown.parts.map((part) => part.money),
				...(breakdown.hotel?.rows ?? []).map((row) => row.money)
			];
			expect(sumMoney(amounts[0]!, ...amounts.slice(1))).toEqual(breakdown.total);
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

	// Issue #305 -------------------------------------------------------------

	it('puts the nightly rate on the hotel group rather than inside a sentence', () => {
		// The owner asked for "a group with `Hotel` as title and at right `€52.85/night`".
		// A rate is a rate wherever it is printed, so it reads the way AGENTS.md fixes every
		// other rate in this app: symbol first, "/night", no padded digits.
		expect(priceBreakdown(makeItinerary({ nightsInConnection: 1 })).hotel?.rate).toBe('€20.00/night');
	});

	it('splits the nights into the ones the flights force and the ones the traveller added', () => {
		// Since #230 a stopover opens at its shortest length and the ladder extends it, so
		// "3 nights" is two different decisions added together. This is the only place on
		// the card that says which of them a traveller could still drop.
		const rows = priceBreakdown(makeItinerary({ nightsInConnection: 3 }), { requiredNights: 1 }).hotel?.rows;

		expect(rows?.map((row) => row.label)).toEqual(['1 required night', '2 extra nights']);
		expect(rows?.map((row) => row.money.minorUnits)).toEqual([2000, 4000]);
	});

	it('calls every night required when nobody said which were chosen', () => {
		// A caller without the group behind the card cannot know that any night was picked,
		// and calling a forced night "extra" would tell a traveller they can drop it.
		const rows = priceBreakdown(makeItinerary({ nightsInConnection: 2 })).hotel?.rows;

		expect(rows?.map((row) => row.label)).toEqual(['2 required nights']);
	});

	it('prints no extra row when the trip is at its shortest length', () => {
		const rows = priceBreakdown(makeItinerary({ nightsInConnection: 2 }), { requiredNights: 2 }).hotel?.rows;

		expect(rows?.map((row) => row.id)).toEqual(['required']);
	});

	it('has no hotel group at all when nothing priced a bed', () => {
		expect(priceBreakdown(withoutStay(makeItinerary({ nightsInConnection: 4 }))).hotel).toBeUndefined();
		expect(priceBreakdown(makeItinerary({ nightsInConnection: 0 })).hotel).toBeUndefined();
	});

	// Issue #206 -------------------------------------------------------------

	it('prints one bare rate for one traveller, since per person and per party agree', () => {
		// "€13.00/night each" beside a party of one is noise.
		expect(priceBreakdown(makeItinerary({ nightsInConnection: 1, travellers: 1 })).hotel?.rate).toBe('€20.00/night');
	});

	it('says who a room rate covers rather than dividing it between them', () => {
		// The `Stay` fixture is a private room, which is one unit of inventory whatever the
		// party size — measured, not assumed: Hostelworld sells a 4-bed private for roughly
		// what its four beds cost separately, and says in its own words that three people
		// booking one pay for four (docs/PROVIDERS.md). Splitting that by heads would print
		// a figure no provider ever quoted, which is exactly what issue #206 warned about.
		const party = priceBreakdown(makeItinerary({ nightsInConnection: 2, travellers: 3 }));
		expect(party.hotel?.rate).toBe('€20.00/night for 3');
	});

	it('prints the per-person rate a provider actually quoted, marked as each', () => {
		// A Hostelworld dorm bed. `pricePerNight` is the party's cost and
		// `pricePerPersonPerNight` is the rate it was multiplied up from, so this figure is
		// the response's own number rather than a division of a total.
		const base = makeItinerary({ nightsInConnection: 2, travellers: 3 });
		const inADorm: Itinerary = {
			...base,
			stay: {
				...base.stay!,
				roomKind: 'dorm',
				pricePerNight: { minorUnits: 3900, currency: 'EUR' },
				pricePerPersonPerNight: { minorUnits: 1300, currency: 'EUR' }
			}
		};

		const hotel = priceBreakdown(inADorm).hotel;
		expect(hotel?.rate).toBe('€13.00/night each');
		// And the rows stay the party's, because that is what the total is built from.
		expect(hotel?.rows.map((row) => row.money)).toEqual([{ minorUnits: 7800, currency: 'EUR' }]);
	});

	it('omits a ground line while no transfer provider prices one', () => {
		// domain/transfer.ts: no adapter populates `Transfer.price` today. A zero row here
		// would read as "this taxi is free", which is a claim nobody measured. A taxi on
		// purpose rather than `makeItinerary`'s walked default, because the claim really is
		// true of a walk and `walkedTransferCount` is where that belongs.
		const taxi = { mode: 'taxi' as const, duration: 30 as Duration, legs: [] };
		const byTaxi = { ...makeItinerary({}), transferToHotel: taxi, transferToConnectionAirport: taxi };
		expect(priceBreakdown(byTaxi).parts.some((part) => part.id === 'ground')).toBe(false);
	});

	it('says how many rides a ground line paid for', () => {
		// Issue #225's receipt reads "Ground, 3 rides €13.00". The count is what the money
		// bought, and it uses the same wording as the unpriced chip so a trip with two
		// quoted rides and two unquoted ones reads as four legs rather than as one line
		// contradicting the other.
		const bus = { mode: 'transit' as const, duration: 25 as Duration, legs: [], price: { minorUnits: 650, currency: 'EUR' } };
		const withFares = { ...makeItinerary({}), transferToHotel: bus, transferToConnectionAirport: bus };
		const ground = priceBreakdown(withFares).parts.find((part) => part.id === 'ground');

		expect(ground?.detail).toBe('2 rides');
		expect(ground?.money).toEqual({ minorUnits: 1300, currency: 'EUR' });
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

	// Issue #249 --------------------------------------------------------------

	it('counts the walked legs as well as the ones nobody quoted', () => {
		// The shape measured on production on 2026-09-05 with an origin and a destination
		// location filled in: the walk to the departure airport, then three taxis. The card
		// read "Ground, 3 rides not priced" and said nothing whatsoever about the walk,
		// which is the one ground leg whose price this app actually knows.
		const walk = { mode: 'walk' as const, duration: 15 as Duration, legs: [] };
		const taxi = { mode: 'taxi' as const, duration: 30 as Duration, legs: [] };
		const breakdown = priceBreakdown({
			...makeItinerary({ nightsInConnection: 1 }),
			transferToOriginAirport: walk,
			transferToHotel: taxi,
			transferToConnectionAirport: taxi,
			transferToDestinationLocation: taxi
		});

		expect(breakdown.walkedTransferCount).toBe(1);
		expect(breakdown.unpricedTransferCount).toBe(3);
	});

	it('counts a walked trip as walked rather than as nothing', () => {
		// `makeItinerary`'s two default legs are walks. Both counts were zero here, so the
		// receipt printed no ground line, which reads identically to a trip that has no
		// ground legs at all.
		const breakdown = priceBreakdown(makeItinerary({ nightsInConnection: 1 }));
		expect(breakdown.walkedTransferCount).toBe(2);
		expect(breakdown.unpricedTransferCount).toBe(0);
	});

	it('keeps the total complete when every ground leg is walked', () => {
		// The other half of the same rule, and the half that was already right: a trip whose
		// ground costs nothing is fully priced and must not apologise for itself. Pinned
		// because the walk count is now read on the same screen and the two must not drift.
		expect(itineraryMetrics(makeItinerary({ nightsInConnection: 1 }), ['total-price'])[0]!.note).toBeUndefined();
	});

	it('claims no walk on a leg nobody could route', () => {
		// Issue #211: a leg that does not exist is neither free nor quoted. Counting it as a
		// walk would turn a routing failure into good news.
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...unrouted } = makeItinerary({
			nightsInConnection: 3
		});
		const breakdown = priceBreakdown(unrouted as Itinerary);

		expect(breakdown.walkedTransferCount).toBe(0);
		expect(breakdown.unpricedTransferCount).toBe(2);
	});

	it('counts a walk somebody quoted as money, not as a free leg', () => {
		// Nothing produces a priced walk today. If a provider ever quotes a shuttle as one,
		// its fare belongs in the ground total rather than in a count whose whole claim is
		// that these legs cost nothing.
		const paidWalk = {
			mode: 'walk' as const,
			duration: 15 as Duration,
			legs: [],
			price: { minorUnits: 200, currency: 'EUR' }
		};
		const breakdown = priceBreakdown({
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: paidWalk,
			transferToConnectionAirport: paidWalk
		});

		expect(breakdown.walkedTransferCount).toBe(0);
		expect(breakdown.parts.find((part) => part.id === 'ground')?.money).toEqual({
			minorUnits: 400,
			currency: 'EUR'
		});
	});
});

// Issue #249 -----------------------------------------------------------------

describe('priceBreakdown: a ride the rate card can describe', () => {
	/** A taxi carrying the range OSRM's rate table produced for its own route. `price` stays
	 * undefined, which is the point: this is a guess, and the receipt has to show it as one. */
	function ratedTaxi(lowMinorUnits: number, highMinorUnits: number, currency: string): Transfer {
		return {
			mode: 'taxi',
			duration: 22 as Duration,
			legs: [],
			fareEstimate: {
				kind: 'estimate',
				currency: currency as Money['currency'],
				lowMinorUnits,
				highMinorUnits,
				countryCode: 'GB',
				rateSource: 'country',
				citation: 'London black-cab Tariff 1'
			}
		};
	}

	/** A taxi past what any card in the table reaches, which is issue #246's Gatwick run. */
	const unratedTaxi: Transfer = {
		mode: 'taxi',
		duration: 76 as Duration,
		legs: [],
		fareEstimate: {
			kind: 'out-of-range',
			distanceKm: 94.9,
			ratedUpToKm: 30,
			countryCode: 'GB',
			citation: 'London black-cab Tariff 1'
		}
	};

	it('sums the estimated rides into their own line, never into the total', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: ratedTaxi(2426, 3830, 'GBP')
		};
		const breakdown = priceBreakdown(trip);

		expect(breakdown.estimatedGround).toEqual([
			{ rides: 2, currency: 'GBP', lowMinorUnits: 4852, highMinorUnits: 7660 }
		]);
		// The load-bearing assertion. `total` is `Itinerary.totalPrice`, which
		// `algorithm/build.ts` builds from quoted money alone, and `results/sort.ts` and
		// `results/filters.ts` both read it as if every unit in it were real.
		expect(breakdown.total).toEqual(makeItinerary({ nightsInConnection: 1 }).totalPrice);
		expect(breakdown.parts.some((part) => part.id === 'ground')).toBe(false);
	});

	it('stops calling an estimated ride unpriced, so no leg is counted twice', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: ratedTaxi(2426, 3830, 'GBP')
		};
		const breakdown = priceBreakdown(trip);

		expect(breakdown.unpricedTransferCount).toBe(0);
		expect(breakdown.walkedTransferCount).toBe(0);
	});

	it('keeps a ride past the card range in the unpriced count, with no figure attached', () => {
		// Issue #246 refuses to rate a 94.9 km motorway run off a card back-calculated from a
		// 5.1 km city ride. That refusal is still a hole in the total, and the receipt says so
		// rather than quietly reporting one leg where the trip has two.
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: unratedTaxi
		};
		const breakdown = priceBreakdown(trip);

		expect(breakdown.estimatedGround).toEqual([
			{ rides: 1, currency: 'GBP', lowMinorUnits: 2426, highMinorUnits: 3830 }
		]);
		expect(breakdown.unpricedTransferCount).toBe(1);
	});

	it('never estimates a bus, because Transitous quotes no fares at all', () => {
		const bus: Transfer = { mode: 'transit', duration: 35 as Duration, legs: [] };
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: bus,
			transferToConnectionAirport: bus
		};
		const breakdown = priceBreakdown(trip);

		expect(breakdown.estimatedGround).toEqual([]);
		expect(breakdown.unpricedTransferCount).toBe(2);
	});

	it('splits two currencies into two lines rather than adding them up', () => {
		// A trip with an origin location in Spain and a stopover in Britain rates one leg
		// against the EUR card and the other against the GBP one. `sumMoney` throws on that
		// mix by design and nothing in this repo converts, so the receipt says both.
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToOriginAirport: ratedTaxi(1300, 1900, 'EUR'),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: ratedTaxi(2426, 3830, 'GBP')
		};
		const breakdown = priceBreakdown(trip);

		expect(breakdown.estimatedGround).toEqual([
			{ rides: 1, currency: 'EUR', lowMinorUnits: 1300, highMinorUnits: 1900 },
			{ rides: 2, currency: 'GBP', lowMinorUnits: 4852, highMinorUnits: 7660 }
		]);
	});

	it('puts the size of the gap in the caveat under the total', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: ratedTaxi(2426, 3830, 'GBP')
		};
		expect(itineraryMetrics(trip, ['total-price'])[0]!.note).toBe(
			'excludes ground transport, about £48.52-£76.60'
		);
	});

	it('names no figure when part of the ground has none, rather than one that covers half of it', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP'),
			transferToConnectionAirport: unratedTaxi
		};
		expect(itineraryMetrics(trip, ['total-price'])[0]!.note).toBe('excludes unpriced ground transport');
	});

	it('names no figure when two currencies are involved, for the same reason', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToOriginAirport: ratedTaxi(1300, 1900, 'EUR'),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP')
		};
		expect(itineraryMetrics(trip, ['total-price'])[0]!.note).toBe('excludes unpriced ground transport');
	});

	it('still says a bed is missing alongside an estimated ride', () => {
		const trip = {
			...withoutStay(makeItinerary({ nightsInConnection: 3 })),
			transferToHotel: ratedTaxi(2426, 3830, 'GBP')
		};
		expect(itineraryMetrics(trip, ['total-price'])[0]!.note).toBe('excludes a bed and ground transport');
	});
});

// Issue #305 -----------------------------------------------------------------

describe('priceBreakdown: the receipt names each ground leg', () => {
	function ratedTaxi(lowMinorUnits: number, highMinorUnits: number, currency: string): Transfer {
		return {
			mode: 'taxi',
			duration: 22 as Duration,
			legs: [],
			fareEstimate: {
				kind: 'estimate',
				currency: currency as Money['currency'],
				lowMinorUnits,
				highMinorUnits,
				countryCode: 'GB',
				rateSource: 'country',
				citation: 'London black-cab Tariff 1'
			}
		};
	}

	const walk: Transfer = { mode: 'walk', duration: 12 as Duration, legs: [] };
	const bus: Transfer = { mode: 'transit', duration: 35 as Duration, legs: [] };

	it('folds the two hotel-side rides into the one row the owner named', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: ratedTaxi(1200, 1900, 'EUR'),
			transferToConnectionAirport: ratedTaxi(1200, 1900, 'EUR')
		};

		expect(priceBreakdown(trip).groundRows).toEqual([
			{
				id: 'hotel',
				label: 'Rides from and to hotel',
				cost: { kind: 'estimated', currency: 'EUR', lowMinorUnits: 2400, highMinorUnits: 3800 }
			}
		]);
	});

	it('splits the pair when the two legs are different kinds of answer', () => {
		// A walk out and a taxi back are two facts. One row saying either "free" or a range
		// about the pair would be false in one direction, which is the whole reason the
		// aggregate rows this replaced were wrong.
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: walk,
			transferToConnectionAirport: ratedTaxi(1200, 1900, 'EUR')
		};

		expect(priceBreakdown(trip).groundRows).toEqual([
			{ id: 'to-hotel', label: 'Ride to hotel', cost: { kind: 'free' } },
			{
				id: 'from-hotel',
				label: 'Ride from hotel',
				cost: { kind: 'estimated', currency: 'EUR', lowMinorUnits: 1200, highMinorUnits: 1900 }
			}
		]);
	});

	it('names the outer legs from the traveller end, in trip order', () => {
		const trip = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToOriginAirport: bus,
			transferToDestinationLocation: bus
		};

		expect(priceBreakdown(trip).groundRows.map((row) => row.label)).toEqual([
			'Ride from origin',
			'Rides from and to hotel',
			'Ride to destination'
		]);
	});

	it('gives no row to an outer leg the trip does not have', () => {
		// Absent because the query carried no origin or destination location, which is a
		// trip with no such ride rather than a ride nobody could route.
		expect(priceBreakdown(makeItinerary({ nightsInConnection: 1 })).groundRows.map((row) => row.id)).toEqual([
			'hotel'
		]);
	});

	it('still prints the hotel row when the bed exists and nothing could route to it', () => {
		// Issue #211: the traveller has to reach that bed and come back whether or not any
		// provider answered, so the row says "not priced" rather than vanishing.
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...unrouted } = makeItinerary({
			nightsInConnection: 3
		});

		expect(priceBreakdown(unrouted as Itinerary).groundRows).toEqual([
			{ id: 'hotel', label: 'Rides from and to hotel', cost: { kind: 'unknown' } }
		]);
	});

	it('gives a same-day connection no hotel row, because it has no bed to reach', () => {
		const { transferToHotel: _to, transferToConnectionAirport: _back, ...sameDay } = withoutStay(
			makeItinerary({ nightsInConnection: 0 })
		);

		expect(priceBreakdown(sameDay as Itinerary).groundRows).toEqual([]);
	});

	it('reads a bus as unknown and a walk as free, never as the same thing', () => {
		// `domain/transfer.ts`'s two readings of an absent price, carried onto the receipt
		// per row instead of into two counts. This is the distinction issue #249 made and
		// the one a single "Ground" line could not print.
		const byBus = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: bus,
			transferToConnectionAirport: bus
		};
		const onFoot = {
			...makeItinerary({ nightsInConnection: 1 }),
			transferToHotel: walk,
			transferToConnectionAirport: walk
		};

		expect(priceBreakdown(byBus).groundRows[0]!.cost).toEqual({ kind: 'unknown' });
		expect(priceBreakdown(onFoot).groundRows[0]!.cost).toEqual({ kind: 'free' });
	});
});
