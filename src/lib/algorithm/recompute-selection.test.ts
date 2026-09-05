import { describe, expect, it } from 'vitest';
import type { Airport, City, Country, Duration, FlightFarePriceScope, FlightOffer, LocalDateTime, Stay, Transfer } from '../domain';
import { buildItineraries, type BuildItinerariesInput } from './build';
import { diffFlightOffers, diffTransfers, recomputeItinerarySelection } from './recompute-selection';

const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string): Airport {
	return {
		iataCode,
		name: `${iataCode} airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country,
		sizeClass: 'medium'
	};
}

function localDateTime(local: string, timeZone = 'Europe/Vienna', utcOffsetMinutes = 120): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

function makeFlight(
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	duration: number,
	priceMinorUnits = 5000,
	priceScope: FlightFarePriceScope = 'per-person'
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR1',
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		priceScope,
		duration: duration as Duration,
		price: { minorUnits: priceMinorUnits, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function makeStay(pricePerNightMinorUnits = 3000): Stay {
	return {
		property: { name: 'Test Hostel', coordinates: { latitude: 0, longitude: 0 }, images: [] },
		roomKind: 'dorm',
		pricePerNight: { minorUnits: pricePerNightMinorUnits, currency: 'EUR' }
	};
}

function makeTransfer(duration: number, priceMinorUnits?: number, mode: Transfer['mode'] = 'walk'): Transfer {
	return {
		mode,
		duration: duration as Duration,
		price: priceMinorUnits !== undefined ? { minorUnits: priceMinorUnits, currency: 'EUR' } : undefined,
		legs: []
	};
}

const origin = makeAirport('LGW');
const connection = makeAirport('VIE');
const destination = makeAirport('IST');

function baseInput(overrides: Partial<BuildItinerariesInput> = {}): BuildItinerariesInput {
	return {
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [],
		onwardOffers: [],
		connectionAirports: { VIE: connection },
		connectionResources: {
			VIE: { stay: makeStay(), transferToHotel: makeTransfer(5), transferToConnectionAirport: makeTransfer(5) }
		},
		waitingTimeRules: [{ waitingTime: 0 as Duration }],
		...overrides
	};
}

/** One itinerary with a 40-minute layover (above the 30-minute default minimum), zero
 * airport-waiting buffers so free time equals the raw gap minus the two transfers. */
function baseItinerary() {
	const outboundArrival = localDateTime('2026-06-01T10:00:00');
	const onwardDeparture = localDateTime('2026-06-01T10:40:00');
	const outbound = makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150);
	const onward = makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90);
	const [itinerary] = buildItineraries(baseInput({ outboundOffers: [outbound], onwardOffers: [onward] }));
	if (!itinerary) throw new Error('fixture itinerary failed to build');
	return itinerary;
}

describe('recomputeItinerarySelection: minimum layover', () => {
	it('picking a later outbound flight that breaks the min layover surfaces a clear warning', () => {
		const itinerary = baseItinerary();
		expect(itinerary.freeTime.duration).toBeGreaterThanOrEqual(0);

		// Onward still departs at 10:40; this alternative outbound lands at 10:25, leaving
		// only 15 minutes, under the 30-minute default minimum layover.
		const laterArrival = localDateTime('2026-06-01T10:25:00');
		const laterOutbound = makeFlight('LGW', 'VIE', laterArrival, laterArrival, 175);

		const result = recomputeItinerarySelection(itinerary, { outboundFlight: laterOutbound });

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe('layover-too-short');
		expect(result.warnings[0]?.message).toMatch(/15 minutes/);
		expect(result.itinerary.outboundFlight).toBe(laterOutbound);
	});

	it('does not warn when the new pairing still clears the minimum layover', () => {
		const itinerary = baseItinerary();
		const earlierArrival = localDateTime('2026-06-01T09:30:00');
		const earlierOutbound = makeFlight('LGW', 'VIE', earlierArrival, earlierArrival, 120);

		const result = recomputeItinerarySelection(itinerary, { outboundFlight: earlierOutbound });

		expect(result.warnings).toHaveLength(0);
		expect(result.itinerary.freeTime.duration).toBeGreaterThan(itinerary.freeTime.duration);
	});

	/**
	 * Issue #247. Production, 2026-09-05, the BVC to PFO reference search: the second
	 * outbound alternative was refused with "Only -3230 minutes between the flights, below
	 * the 30-minute minimum layover."
	 *
	 * The number is right and the sentence is not. Both flights land at LGW, both times are
	 * LGW's own, and `minutesBetween` converts each `LocalDateTime` through its own offset
	 * before subtracting, so this was never a timezone fault. BY625 lands 9 Oct 9:10pm and
	 * the onward flight left 7 Oct 3:20pm — 3230 minutes earlier. There is no layover here
	 * at all, short or otherwise, and a negative one is not a duration to print.
	 */
	it('says the flights are out of order rather than quoting a negative layover', () => {
		const itinerary = baseItinerary();
		// Onward departs 10:40 on 1 June. This outbound lands two days after it.
		const landsAfterOnwardLeft = localDateTime('2026-06-03T21:10:00');
		const tooLate = makeFlight('LGW', 'VIE', landsAfterOnwardLeft, landsAfterOnwardLeft, 175);

		const result = recomputeItinerarySelection(itinerary, { outboundFlight: tooLate });

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe('flights-out-of-order');
		expect(result.warnings[0]?.message).toBe(
			'The onward flight leaves before this one lands, so there is no connection to make.'
		);
		// The one thing this must never do again, whatever the wording ends up being.
		expect(result.warnings[0]?.message).not.toMatch(/-\d/);
		expect(result.itinerary.outboundFlight).toBe(tooLate);
	});

	it('keeps the minute figure for the case the sentence was written for', () => {
		// A gap that is positive and under the minimum still reads as a layover, because
		// that is what it is. Only the sign changes which fact is being reported.
		const itinerary = baseItinerary();
		const laterArrival = localDateTime('2026-06-01T10:39:00');
		const oneMinuteShort = makeFlight('LGW', 'VIE', laterArrival, laterArrival, 175);

		const result = recomputeItinerarySelection(itinerary, { outboundFlight: oneMinuteShort });

		expect(result.warnings[0]?.code).toBe('layover-too-short');
		expect(result.warnings[0]?.message).toContain('Only 1 minute between the flights');
	});
});

describe('recomputeItinerarySelection: connection time', () => {
	it('warns when a longer transfer leaves no free time, without throwing or dropping the pick', () => {
		const itinerary = baseItinerary();
		// The base fixture's 30 minutes of free time is comfortably positive; picking a
		// transfer this long from the hotel to the connection airport eats all of it and more.
		const veryLongTransfer = makeTransfer(10_000);

		const result = recomputeItinerarySelection(itinerary, { transferToConnectionAirport: veryLongTransfer });

		expect(result.warnings.map((warning) => warning.code)).toContain('insufficient-connection-time');
		expect(result.itinerary.freeTime.duration).toBeLessThan(0);
		expect(result.itinerary.nightsInConnection).toBe(0);
		expect(result.itinerary.transferToConnectionAirport).toBe(veryLongTransfer);
	});
});

describe('recomputeItinerarySelection: totals and nights', () => {
	it('recomputes nights, free time and total price together when a flight swap crosses a night', () => {
		const itinerary = baseItinerary();
		expect(itinerary.nightsInConnection).toBe(0); // same calendar day, per the base fixture

		// Push the onward departure to the next morning: free time now spans a calendar date,
		// so nights should become 1 and the stay's per-night price should join the total.
		const nextMorningDeparture = localDateTime('2026-06-02T08:00:00');
		const laterOnward = makeFlight('VIE', 'IST', nextMorningDeparture, nextMorningDeparture, 90, 6000);

		const result = recomputeItinerarySelection(itinerary, { onwardFlight: laterOnward });

		expect(result.warnings).toHaveLength(0);
		expect(result.itinerary.nightsInConnection).toBe(1);
		expect(result.itinerary.onwardFlight.price.minorUnits).toBe(6000);
		// outbound (5000) + onward (6000) + one night (3000) + two zero-duration/zero-price
		// transfers already on the fixture = 14000.
		expect(result.itinerary.totalPrice.minorUnits).toBe(14000);
		expect(result.itinerary.times.inFlight).toBe(150 + 90);
	});

	it('keeps scaling flight fares by the carried-over party size after a flight swap (issue #106)', () => {
		const solo = baseItinerary();
		const group = { ...solo, travellers: 3 };

		const cheaperOutbound = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-06-01T09:00:00'),
			localDateTime('2026-06-01T09:00:00'),
			150,
			4000
		);

		const soloResult = recomputeItinerarySelection(solo, { outboundFlight: cheaperOutbound });
		const groupResult = recomputeItinerarySelection(group, { outboundFlight: cheaperOutbound });

		expect(groupResult.itinerary.travellers).toBe(3);
		// Flights only (this fixture's stay never gets a priced night — same calendar day):
		// onward stays at its default 5000; solo = 4000 + 5000, group = (4000 + 5000) * 3.
		expect(soloResult.itinerary.totalPrice.minorUnits).toBe(4000 + 5000);
		expect(groupResult.itinerary.totalPrice.minorUnits).toBe((4000 + 5000) * 3);
	});

	it('does not multiply a party-total fare swapped in by a picker (issue #109)', () => {
		const group = { ...baseItinerary(), travellers: 3 };
		// Swapping in an already-party-total offer (e.g. a Skyscanner alternative) must not
		// get tripled on top of already covering all three travellers.
		const partyTotalOutbound = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-06-01T09:00:00'),
			localDateTime('2026-06-01T09:00:00'),
			150,
			18000,
			'party-total'
		);

		const result = recomputeItinerarySelection(group, { outboundFlight: partyTotalOutbound });

		// 18000 (already for all three, untouched) + onward's default 5000 * 3 (per-person).
		expect(result.itinerary.totalPrice.minorUnits).toBe(18000 + 5000 * 3);
	});

	it('leaves every other field untouched when only one transfer is overridden', () => {
		const itinerary = baseItinerary();
		const newHotelTransfer = makeTransfer(15, 200, 'taxi');

		const result = recomputeItinerarySelection(itinerary, { transferToHotel: newHotelTransfer });

		expect(result.itinerary.transferToHotel).toBe(newHotelTransfer);
		expect(result.itinerary.outboundFlight).toBe(itinerary.outboundFlight);
		expect(result.itinerary.onwardFlight).toBe(itinerary.onwardFlight);
		expect(result.itinerary.originWaitingTime).toBe(itinerary.originWaitingTime);
		expect(result.itinerary.connectionWaitingTime).toBe(itinerary.connectionWaitingTime);
	});
});

describe('recomputeItinerarySelection: no stay priced (issue #94)', () => {
	/** Same schedule as `baseItinerary`, but built from a connection with no stay resolved
	 * — the exact shape `fetchConnectionResources` degrades to when no provider prices a
	 * bed for the connection. */
	function itineraryWithoutStay() {
		const outboundArrival = localDateTime('2026-06-01T10:00:00');
		const onwardDeparture = localDateTime('2026-06-01T10:40:00');
		const outbound = makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150);
		const onward = makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90);
		const [itinerary] = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [onward], connectionResources: { VIE: {} } })
		);
		if (!itinerary) throw new Error('fixture itinerary failed to build');
		return itinerary;
	}

	it('swaps a flight without crashing, keeping the stay absent and pricing only the flights', () => {
		const itinerary = itineraryWithoutStay();
		expect(itinerary.stay).toBeUndefined();

		const earlierArrival = localDateTime('2026-06-01T09:30:00');
		const earlierOutbound = makeFlight('LGW', 'VIE', earlierArrival, earlierArrival, 120, 4500);

		const result = recomputeItinerarySelection(itinerary, { outboundFlight: earlierOutbound });

		expect(result.warnings).toHaveLength(0);
		expect(result.itinerary.stay).toBeUndefined();
		expect(result.itinerary.nightsInConnection).toBe(0);
		// outbound (4500) + onward (5000, the fixture default), no stay and no transfer
		// legs to add — never a guessed bed cost.
		expect(result.itinerary.totalPrice.minorUnits).toBe(4500 + 5000);
	});
});

describe('diffFlightOffers', () => {
	const current = makeFlight(
		'LGW',
		'VIE',
		localDateTime('2026-06-01T10:00:00'),
		localDateTime('2026-06-01T12:30:00'),
		150,
		5000
	);

	it('reports a positive price delta and "later" departure for a pricier, later alternative', () => {
		const alternative = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-06-01T10:40:00'),
			localDateTime('2026-06-01T13:10:00'),
			150,
			5200
		);

		const delta = diffFlightOffers(current, alternative);

		expect(delta.currencyMismatch).toBe(false);
		expect(delta.priceDeltaMinorUnits).toBe(200); // "+€12" style delta, here +€2
		expect(delta.departureDeltaMinutes).toBe(40); // "40 minutes later"
		expect(delta.arrivalDeltaMinutes).toBe(40);
		expect(delta.durationDeltaMinutes).toBe(0);
	});

	it('reports a negative delta for a cheaper, earlier alternative', () => {
		const alternative = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-06-01T09:00:00'),
			localDateTime('2026-06-01T11:30:00'),
			150,
			4500
		);

		const delta = diffFlightOffers(current, alternative);

		expect(delta.priceDeltaMinorUnits).toBe(-500);
		expect(delta.departureDeltaMinutes).toBe(-60);
	});

	it('is DST-correct: a departure delta across a UTC-offset change is not a naive wall-clock subtraction', () => {
		// Same fixture as build.test.ts's own DST case: Europe/Vienna falls back an hour
		// overnight on 2026-10-25, so two flights 24h apart on the wall clock are really 25h
		// apart in elapsed time.
		const before = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-10-24T22:00:00', 'Europe/Vienna', 120),
			localDateTime('2026-10-24T22:00:00', 'Europe/Vienna', 120),
			150
		);
		const after = makeFlight(
			'LGW',
			'VIE',
			localDateTime('2026-10-25T22:00:00', 'Europe/Vienna', 60),
			localDateTime('2026-10-25T22:00:00', 'Europe/Vienna', 60),
			150
		);

		expect(diffFlightOffers(before, after).departureDeltaMinutes).toBe(25 * 60);
	});

	it('never fabricates a price delta across mismatched currencies', () => {
		const alternative: FlightOffer = {
			...current,
			price: { minorUnits: 4000, currency: 'GBP' }
		};

		const delta = diffFlightOffers(current, alternative);

		expect(delta.currencyMismatch).toBe(true);
		expect(delta.priceDeltaMinorUnits).toBeUndefined();
	});
});

describe('diffTransfers', () => {
	it('compares price and duration when both alternatives are priced in the same currency', () => {
		const current = makeTransfer(45, 300, 'walk');
		const alternative = makeTransfer(12, 250, 'taxi');

		const delta = diffTransfers(current, alternative);

		expect(delta.hasPriceComparison).toBe(true);
		expect(delta.currencyMismatch).toBe(false);
		expect(delta.priceDeltaMinorUnits).toBe(-50);
		expect(delta.durationDeltaMinutes).toBe(-33);
	});

	it('never claims a price comparison when one side has no price at all (e.g. walking)', () => {
		const current = makeTransfer(45, undefined, 'walk');
		const alternative = makeTransfer(12, 250, 'taxi');

		const delta = diffTransfers(current, alternative);

		expect(delta.hasPriceComparison).toBe(false);
		expect(delta.priceDeltaMinorUnits).toBeUndefined();
		expect(delta.currencyMismatch).toBe(false);
	});
});

describe('recomputeItinerarySelection: swapping the bed (issue #243)', () => {
	/** An overnight stopover with two slow in-city legs, so the journey to the bed really
	 * moves the free-time window, the night count and the total. Those are exactly the
	 * numbers a swap used to leave describing the previous property. */
	function overnightItinerary() {
		const outboundArrival = localDateTime('2026-06-01T21:00:00');
		const onwardDeparture = localDateTime('2026-06-02T12:00:00');
		const outbound = makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150);
		const onward = makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90);
		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: {
					VIE: {
						stay: makeStay(),
						transferAnchor: 'stay',
						transferToHotel: makeTransfer(75),
						transferToConnectionAirport: makeTransfer(45)
					}
				}
			})
		);
		if (!itinerary) throw new Error('fixture itinerary failed to build');
		return itinerary;
	}

	function otherProperty(pricePerNightMinorUnits: number): Stay {
		return {
			...makeStay(pricePerNightMinorUnits),
			property: { name: 'Far Hostel', coordinates: { latitude: 51.5, longitude: -0.1 }, images: [] }
		};
	}

	it("drops both in-city legs rather than lending the new property the old one's journey", () => {
		const before = overnightItinerary();
		expect(before.transferToHotel?.duration).toBe(75);
		expect(before.transferAnchor).toBe('stay');

		const other = otherProperty(4000);
		const { itinerary } = recomputeItinerarySelection(before, { staySelection: { stay: other } });

		expect(itinerary.stay).toBe(other);
		expect(itinerary.transferToHotel).toBeUndefined();
		expect(itinerary.transferToConnectionAirport).toBeUndefined();
		expect(itinerary.transferAnchor).toBe('unrouted-stay');
	});

	it('moves the free-time window off the old journey instead of leaving it where it was', () => {
		const before = overnightItinerary();
		// It used to start 75 minutes after landing and end 45 minutes before the departure.
		expect(before.freeTime.start.local).toBe('2026-06-01T22:15:00');
		expect(before.freeTime.end.local).toBe('2026-06-02T11:15:00');

		const { itinerary } = recomputeItinerarySelection(before, {
			staySelection: { stay: otherProperty(4000) }
		});

		// With no journey to this address, the honest window runs from landing to departure:
		// the app cannot deduct minutes nobody has measured.
		expect(itinerary.freeTime.start).toEqual(before.outboundFlight.arrival);
		expect(itinerary.freeTime.end).toEqual(before.onwardFlight.departure);
		expect(itinerary.times.free).toBe(itinerary.freeTime.duration);
	});

	it('rebuilds the total from the trip rather than nudging the old one by a delta', () => {
		const before = overnightItinerary();

		const { itinerary } = recomputeItinerarySelection(before, {
			staySelection: { stay: otherProperty(4000) }
		});

		// Both fares (5000 each, per-person, one traveller) plus this bed's own nights. The
		// previous bed's 3000 a night is gone from the figure, not subtracted back out of it.
		expect(itinerary.nightsInConnection).toBe(1);
		expect(itinerary.totalPrice.minorUnits).toBe(5000 + 5000 + 4000);
	});

	it('restores the journey and the anchor when the routed property is picked back', () => {
		const before = overnightItinerary();
		const { itinerary: swapped } = recomputeItinerarySelection(before, {
			staySelection: { stay: otherProperty(4000) }
		});

		const { itinerary: backAgain } = recomputeItinerarySelection(swapped, {
			staySelection: {
				stay: before.stay,
				transferToHotel: before.transferToHotel,
				transferToConnectionAirport: before.transferToConnectionAirport
			}
		});

		expect(backAgain.transferAnchor).toBe('stay');
		expect(backAgain.transferToHotel).toBe(before.transferToHotel);
		expect(backAgain.freeTime).toEqual(before.freeTime);
		expect(backAgain.totalPrice).toEqual(before.totalPrice);
		expect(backAgain.times).toEqual(before.times);
	});

	it('leaves a transport swap alone, which replaces one leg and keeps the bed it reaches', () => {
		const before = overnightItinerary();
		const faster = makeTransfer(20, 500, 'taxi');

		const { itinerary } = recomputeItinerarySelection(before, { transferToHotel: faster });

		expect(itinerary.transferToHotel).toBe(faster);
		expect(itinerary.stay).toBe(before.stay);
		expect(itinerary.transferToConnectionAirport).toBe(before.transferToConnectionAirport);
		expect(itinerary.transferAnchor).toBe('stay');
	});
});
