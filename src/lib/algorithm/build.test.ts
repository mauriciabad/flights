import { describe, expect, it } from 'vitest';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightFarePriceScope,
	FlightOffer,
	LocalDateTime,
	Stay,
	Transfer,
	WaitingTimeRule
} from '../domain';
import {
	buildItineraries,
	recomputeItineraryWaitingTimes,
	type BuildItinerariesInput,
	type ConnectionResources
} from './build';

const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string, sizeClass: Airport['sizeClass'] = 'medium'): Airport {
	return {
		iataCode,
		name: `${iataCode} airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country,
		sizeClass
	};
}

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
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

function makeTransfer(duration: number, priceMinorUnits?: number): Transfer {
	return {
		mode: 'walk',
		duration: duration as Duration,
		price: priceMinorUnits !== undefined ? { minorUnits: priceMinorUnits, currency: 'EUR' } : undefined,
		legs: []
	};
}

/** A single-tier flat rule so tests can pin the waiting-time buffer to one known number
 * regardless of airport size or flight length. */
function flatWaitingTime(minutes: number): WaitingTimeRule[] {
	return [{ waitingTime: minutes as Duration }];
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
			VIE: { stay: makeStay(), transferToHotel: makeTransfer(0), transferToConnectionAirport: makeTransfer(0) }
		},
		waitingTimeRules: flatWaitingTime(0),
		...overrides
	};
}

describe('buildItineraries — DST correctness', () => {
	it('keeps free time and total duration correct across a DST fallback in the connection city', () => {
		// Europe/Vienna falls back from CEST (+120) to CET (+60) at 03:00 CEST on
		// 2026-10-25. The outbound flight lands the evening before the change; the onward
		// flight leaves the morning after it, so the raw gap between them spans an extra
		// real hour that a naive wall-clock subtraction would silently drop.
		const outboundArrival = localDateTime('2026-10-24T22:00:00', 'Europe/Vienna', 120);
		const onwardDeparture = localDateTime('2026-10-26T08:00:00', 'Europe/Vienna', 60);

		const outbound = makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150);
		const onward = makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90);

		const input = baseInput({
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionResources: {
				VIE: {
					stay: makeStay(),
					transferToHotel: makeTransfer(30),
					transferToConnectionAirport: makeTransfer(30)
				}
			},
			waitingTimeRules: flatWaitingTime(120)
		});

		const [itinerary] = buildItineraries(input);
		expect(itinerary).toBeDefined();

		// Naive wall-clock subtraction of the `local` strings alone gives 31h (1860min)
		// free time; the real elapsed time gains the hour the clocks fell back, landing on
		// 32h (1920min). A build that normalises to UTC without the DST-aware offset
		// subtraction, or that reads the wrong offset, would fail this exact number.
		expect(itinerary.freeTime.duration).toBe(1920);
		expect(itinerary.freeTime.start).toEqual(
			localDateTime('2026-10-24T22:30:00', 'Europe/Vienna', 120)
		);
		expect(itinerary.freeTime.end).toEqual(localDateTime('2026-10-26T05:30:00', 'Europe/Vienna', 60));

		// Total is the sum of every leg, so it carries the same +1h DST correction through:
		// 120 (origin wait) + 150 (outbound) + 30 (to hotel) + 1920 (free) + 30 (to airport)
		// + 120 (connection wait) + 90 (onward) = 2460.
		expect(itinerary.times.total).toBe(2460);
	});
});

describe('buildItineraries — minimum layover', () => {
	it('drops a pair whose flights are closer together than minLayoverTime, but keeps one that clears it', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const tooTightDeparture = localDateTime('2026-06-01T10:20:00', 'Europe/Vienna', 120); // 20min gap
		const okDeparture = localDateTime('2026-06-01T10:40:00', 'Europe/Vienna', 120); // 40min gap

		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const tooTightOnward = makeFlight('VIE', 'IST', tooTightDeparture, tooTightDeparture, 90);
		const okOnward = makeFlight('VIE', 'IST', okDeparture, okDeparture, 90);

		// minLayoverTime left at its 30min default; zero transfer/waiting durations so
		// only the raw flight-to-flight gap decides the outcome, isolating the hard
		// filter from the separate "not enough time for transfers" feasibility check.
		const droppedResult = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [tooTightOnward] })
		);
		expect(droppedResult).toHaveLength(0);

		const keptResult = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [okOnward] })
		);
		expect(keptResult).toHaveLength(1);
	});
});

describe('buildItineraries — nights in connection', () => {
	it('counts a 23:00 arrival to 08:00-next-day departure as one night, not zero', () => {
		// Zero transfer/waiting durations so free time equals the raw flight gap exactly,
		// matching the 23:00 -> 08:00 example from the issue literally.
		const arrival = localDateTime('2026-06-01T23:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-02T08:00:00', 'Europe/Vienna', 120);

		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const [itinerary] = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [onward] })
		);

		expect(itinerary.freeTime.duration).toBe(9 * 60); // 9h of free time...
		expect(itinerary.nightsInConnection).toBe(1); // ...but exactly one hotel night.
	});

	it('counts a same-calendar-day stopover as zero nights even though it runs most of a day', () => {
		const arrival = localDateTime('2026-06-01T00:30:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T20:00:00', 'Europe/Vienna', 120);

		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const [itinerary] = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [onward] })
		);

		expect(itinerary.freeTime.duration).toBe(19 * 60 + 30); // 19h30 free...
		expect(itinerary.nightsInConnection).toBe(0); // ...zero nights: never booked past midnight.
	});
});

describe('buildItineraries — missing stay (issue #94)', () => {
	it('still produces an itinerary when no stay was found for the connection', () => {
		// The exact shape `fetchCheapestStay` returning nothing degrades to (resources.ts):
		// stay, transferToHotel and transferToConnectionAirport all `undefined` together.
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T16:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const result = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: { VIE: {} }
			})
		);

		expect(result).toHaveLength(1);
		const [itinerary] = result;
		expect(itinerary.stay).toBeUndefined();
		expect(itinerary.transferToHotel).toBeUndefined();
		expect(itinerary.transferToConnectionAirport).toBeUndefined();
	});

	it('counts real calendar nights from the schedule even with no stay found, but never guesses a stay cost (issue #105)', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		// A gap that crosses one calendar date, so this proves the opposite of the old
		// behaviour: nights must be genuinely computed here, never hard-zeroed just
		// because no stay was found.
		const departure = localDateTime('2026-06-02T14:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000);

		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: { VIE: {} },
				waitingTimeRules: flatWaitingTime(60)
			})
		);

		expect(itinerary.stay).toBeUndefined();
		expect(itinerary.nightsInConnection).toBe(1);
		// Total is exactly the two flights, no hotel and no in-city transfer legs — never a
		// $0 stay standing in for "unknown".
		expect(itinerary.totalPrice).toEqual({ minorUnits: outbound.price.minorUnits + onward.price.minorUnits, currency: 'EUR' });
	});

	it('reports a genuine 12-night stopover with no stay provider available at all (issue #105)', () => {
		// Exactly the shape of the app's default, keyless first-time-visitor state: every
		// stay provider `needsKey`, so `resources.ts`'s `fetchConnectionResources` degrades
		// to `{}` for the connection — no bed, no hotel-side transfers, nothing but the two
		// flights this free tier already fetched.
		const arrival = localDateTime('2026-10-07T07:35:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-10-19T06:10:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('BCN', 'DUB', arrival, arrival, 150, 3000);
		const onward = makeFlight('DUB', 'TLL', departure, departure, 200, 2854);

		const [itinerary] = buildItineraries(
			baseInput({
				originAirport: makeAirport('BCN'),
				destinationAirport: makeAirport('TLL'),
				connectionAirports: { DUB: makeAirport('DUB') },
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: { DUB: {} },
				waitingTimeRules: flatWaitingTime(120)
			})
		);

		expect(itinerary.stay).toBeUndefined();
		expect(itinerary.nightsInConnection).toBe(12);
	});

	it('runs free time from runway to runway, with no in-city transfer buffer, when no stay was found', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T14:00:00', 'Europe/Vienna', 120); // 4h gap
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: { VIE: {} },
				waitingTimeRules: flatWaitingTime(30) // 30min connection buffer, no hotel transfer to add
			})
		);

		expect(itinerary.freeTime.start).toEqual(arrival); // no transferToHotel duration to add
		expect(itinerary.freeTime.duration).toBe(4 * 60 - 30); // only the connection buffer is subtracted
	});

	it('drops the candidate outright only when there is no resources entry at all for it, not merely no stay', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T14:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const result = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: {} // no VIE entry at all — the flights themselves were never resolved
			})
		);

		expect(result).toHaveLength(0);
	});
});

describe('buildItineraries — total price scales with travellers (issue #106)', () => {
	it('multiplies the per-adult flight fares by the party size, never the flat per-night stay rate', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-02T10:00:00', 'Europe/Vienna', 120); // exactly one night
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000); // €50, per adult
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000); // €60, per adult

		const input = baseInput({
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionResources: {
				VIE: { stay: makeStay(3000), transferToHotel: makeTransfer(0), transferToConnectionAirport: makeTransfer(0) }
			},
			waitingTimeRules: flatWaitingTime(0)
		});

		const [solo] = buildItineraries(input);
		const [group] = buildItineraries({ ...input, travellers: 3 });

		expect(solo.travellers).toBe(1);
		expect(solo.totalPrice.minorUnits).toBe(5000 + 6000 + 3000);

		// Flights scale by party size — (5000 + 6000) * 3 — but the one stay-night stays a
		// flat 3000 for the whole party (issue #80/#94's own documented choice), not *3.
		expect(group.travellers).toBe(3);
		expect(group.totalPrice.minorUnits).toBe((5000 + 6000) * 3 + 3000);
		expect(group.totalPrice.minorUnits).not.toBe(solo.totalPrice.minorUnits);
	});

	it('defaults to 1 traveller when the query omits it, matching DEFAULT_TRAVELLERS', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T14:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000);

		const [itinerary] = buildItineraries(
			baseInput({ outboundOffers: [outbound], onwardOffers: [onward] })
		);

		expect(itinerary.travellers).toBe(1);
		expect(itinerary.totalPrice.minorUnits).toBe(5000 + 6000);
	});
});

describe('buildItineraries — flight price scales per its own priceScope, never a blanket multiply (issue #109)', () => {
	it('does not multiply a party-total fare again, but still multiplies a per-person one on the same itinerary', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T14:00:00', 'Europe/Vienna', 120);
		// Mixed providers on one itinerary: outbound already priced for the whole party
		// (confirmed live for Skyscanner, issue #109), onward still a single adult's fare
		// (Ryanair). A blanket "multiply every flight by travellers" would triple-charge
		// the outbound leg; this must not.
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 30000, 'party-total'); // €300 for the whole party already
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000, 'per-person'); // €60 per adult

		const input = baseInput({
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionResources: { VIE: {} }, // isolate flight pricing from any stay cost
			waitingTimeRules: flatWaitingTime(0)
		});

		const [group] = buildItineraries({ ...input, travellers: 3 });

		// 30000 (already the party total, untouched) + 6000 * 3 (per-adult, multiplied).
		expect(group.totalPrice.minorUnits).toBe(30000 + 6000 * 3);
	});

	it('leaves a solo traveller totalPrice unaffected by priceScope either way', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-01T14:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 30000, 'party-total');
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000, 'per-person');

		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: { VIE: {} },
				waitingTimeRules: flatWaitingTime(0)
			})
		);

		expect(itinerary.travellers).toBe(1);
		expect(itinerary.totalPrice.minorUnits).toBe(30000 + 6000);
	});
});

describe('buildItineraries — airport waiting time vs layover', () => {
	it('counts airport waiting time as only the pre-flight buffers, never the flight-to-flight gap', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		// A full day of raw gap between the flights.
		const departure = localDateTime('2026-06-02T14:00:00', 'Europe/Vienna', 120);

		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90);

		const input = baseInput({
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionResources: {
				VIE: {
					stay: makeStay(),
					transferToHotel: makeTransfer(45),
					transferToConnectionAirport: makeTransfer(45)
				}
			},
			waitingTimeRules: flatWaitingTime(120) // 2h at both ends
		});

		const [itinerary] = buildItineraries(input);

		// 2h origin buffer + 2h connection buffer, full stop — not the ~28h between the
		// two flights and not the ~26.5h of free time either.
		expect(itinerary.times.airportWaiting).toBe(240);
		expect(itinerary.freeTime.duration).toBe(28 * 60 - 45 - 45 - 120);
		expect(itinerary.times.airportWaiting).not.toBe(itinerary.freeTime.duration);
	});
});

describe('recomputeItineraryWaitingTimes, issue #24 inline editing', () => {
	// One fixed itinerary, rebuilt fresh in each test rather than shared, so a mutation in
	// one test (there shouldn't be any: the function returns a new object) can never leak
	// into another.
	function baseItinerary() {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-03T14:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000);

		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: {
					VIE: {
						stay: makeStay(3000),
						transferToHotel: makeTransfer(45),
						transferToConnectionAirport: makeTransfer(45)
					}
				},
				waitingTimeRules: flatWaitingTime(120) // 2h at both ends
			})
		);
		return itinerary;
	}

	it('raising the origin waiting time only grows airportWaiting and total, nothing else', () => {
		const before = baseItinerary();
		const after = recomputeItineraryWaitingTimes(before, { originWaitingTime: 180 as Duration });

		expect(after.originWaitingTime).toBe(180);
		expect(after.times.airportWaiting).toBe(before.times.airportWaiting + 60);
		expect(after.times.total).toBe(before.times.total + 60);
		// Nothing on the connection side moved: origin waiting time happens before a flight
		// whose schedule is already fixed, so it cannot touch free time, nights or price.
		expect(after.freeTime).toEqual(before.freeTime);
		expect(after.nightsInConnection).toBe(before.nightsInConnection);
		expect(after.totalPrice).toEqual(before.totalPrice);
	});

	it('raising the connection waiting time eats into free time but leaves total unchanged', () => {
		const before = baseItinerary();
		const after = recomputeItineraryWaitingTimes(before, { connectionWaitingTime: 180 as Duration });

		expect(after.connectionWaitingTime).toBe(180);
		expect(after.times.airportWaiting).toBe(before.times.airportWaiting + 60);
		// The hour the buffer grew by is exactly the hour free time shrank by, so total,
		// the door-to-door figure, does not move.
		expect(after.freeTime.duration).toBe(before.freeTime.duration - 60);
		expect(after.times.total).toBe(before.times.total);
		expect(after.freeTime.end).toEqual(addMinutesForTest(before.freeTime.end, -60));
		expect(after.freeTime.start).toEqual(before.freeTime.start); // anchored to outbound arrival, untouched
	});

	it('shrinking the connection waiting time can push checkout past midnight, changing nights and price together', () => {
		// nightsBetween counts calendar dates crossed, not hours, so this needs a departure
		// close enough to midnight that trimming the buffer moves free time's end onto a
		// different date. The base itinerary above never crosses one, on purpose, to keep
		// the other cases from depending on this behaviour too.
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		const departure = localDateTime('2026-06-03T02:00:00', 'Europe/Vienna', 120);
		const outbound = makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000);
		const onward = makeFlight('VIE', 'IST', departure, departure, 90, 6000);

		const [before] = buildItineraries(
			baseInput({
				outboundOffers: [outbound],
				onwardOffers: [onward],
				connectionResources: {
					VIE: {
						stay: makeStay(3000),
						transferToHotel: makeTransfer(30),
						transferToConnectionAirport: makeTransfer(30)
					}
				},
				waitingTimeRules: flatWaitingTime(120)
			})
		);
		// freeEnd = 02:00 − (30min transfer + 120min buffer) = 23:30 the night before, so
		// checkout is still on the 2nd: one night.
		expect(before.nightsInConnection).toBe(1);

		// Shrinking the buffer to nothing moves freeEnd to 01:30 on the 3rd instead,
		// checkout has crossed into the next calendar day, so the front desk counts a
		// second night even though free time only grew by two hours.
		const after = recomputeItineraryWaitingTimes(before, { connectionWaitingTime: 0 as Duration });

		expect(after.nightsInConnection).toBe(2);
		// One extra night at 3000 minor units.
		expect(after.totalPrice.minorUnits).toBe(before.totalPrice.minorUnits + 3000);
		expect(after.totalPrice.currency).toBe(before.totalPrice.currency);
	});

	it('editing both buffers at once recomputes every affected total in one pass', () => {
		const before = baseItinerary();
		const after = recomputeItineraryWaitingTimes(before, {
			originWaitingTime: 90 as Duration,
			connectionWaitingTime: 60 as Duration
		});

		expect(after.times.airportWaiting).toBe(150); // 90 + 60
		expect(after.times.total).toBe(before.times.total - 30); // origin −30, connection ±0
		expect(after.freeTime.duration).toBe(before.freeTime.duration + 60);
	});

	it('passing the same values back is a no-op: same reference, not just equal totals', () => {
		const before = baseItinerary();
		const after = recomputeItineraryWaitingTimes(before, {
			originWaitingTime: before.originWaitingTime,
			connectionWaitingTime: before.connectionWaitingTime
		});

		expect(after).toBe(before);
	});

	it('omitting one override leaves that side exactly as it was on the itinerary', () => {
		const before = baseItinerary();
		const after = recomputeItineraryWaitingTimes(before, { originWaitingTime: 240 as Duration });

		expect(after.connectionWaitingTime).toBe(before.connectionWaitingTime);
	});
});

/** Test-only helper: shifts a LocalDateTime by whole minutes for asserting against, kept
 * separate from (and deliberately simpler than) build.ts's own `addLocalMinutes` so this
 * test isn't just checking the implementation against itself. */
function addMinutesForTest(dateTime: LocalDateTime, minutes: number): LocalDateTime {
	const ms = Date.parse(`${dateTime.local}Z`) + minutes * 60_000;
	return {
		local: new Date(ms).toISOString().slice(0, 19),
		timeZone: dateTime.timeZone,
		utcOffsetMinutes: dateTime.utcOffsetMinutes
	};
}

/**
 * Issue #152. The defect these pin was a closed loop: an itinerary that successfully priced
 * a bed was thrown away for having priced one, because the bed came back in USD (the stay
 * query carried no currency) and `sumMoney` refuses to total a mix. `pipeline.ts` caught
 * that throw by discarding the whole candidate. Only the bedless itineraries survived to be
 * rendered — each captioned "No bed priced for this stopover. Total excludes a stay." The
 * app could not display a priced bed no matter what key was configured.
 */
describe('buildItineraries — a wrong-currency stay costs the bed, never the trip (issue #152)', () => {
	function usdStay(pricePerNightMinorUnits = 3000): Stay {
		return {
			property: { name: 'Priced In Dollars', coordinates: { latitude: 0, longitude: 0 }, images: [] },
			roomKind: 'dorm',
			pricePerNight: { minorUnits: pricePerNightMinorUnits, currency: 'USD' }
		};
	}

	function overnightInput(stay: Stay | undefined): BuildItinerariesInput {
		const outboundArrival = localDateTime('2026-10-06T18:00:00', 'Europe/Vienna', 120);
		const onwardDeparture = localDateTime('2026-10-08T10:00:00', 'Europe/Vienna', 120);
		return baseInput({
			outboundOffers: [makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150, 10000)],
			onwardOffers: [makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90, 12000)],
			connectionResources: {
				VIE: stay
					? { stay, transferToHotel: makeTransfer(20), transferToConnectionAirport: makeTransfer(20) }
					: {}
			},
			waitingTimeRules: flatWaitingTime(60)
		});
	}

	it('still builds the itinerary when the stay is quoted in another currency', () => {
		// Before the fix this threw out of `buildItineraries` entirely.
		expect(() => buildItineraries(overnightInput(usdStay()))).not.toThrow();

		const [itinerary] = buildItineraries(overnightInput(usdStay()));
		expect(itinerary).toBeDefined();
	});

	it('drops the bed and totals the flights alone, rather than dropping the trip', () => {
		const [itinerary] = buildItineraries(overnightInput(usdStay()));

		expect(itinerary?.stay).toBeUndefined();
		// Flights only: 10000 + 12000. The USD bed contributes nothing rather than
		// contributing a number in the wrong money.
		expect(itinerary?.totalPrice).toEqual({ minorUnits: 22000, currency: 'EUR' });
	});

	it('still counts the nights, so the stopover does not silently become a same-day connection', () => {
		const [itinerary] = buildItineraries(overnightInput(usdStay()));
		expect(itinerary?.nightsInConnection).toBeGreaterThan(0);
	});

	it('prices the bed into the total when the currencies do match', () => {
		// The positive case, and the one the owner has never seen: two nights at 30.00 EUR
		// on top of 220.00 EUR of flights.
		const [itinerary] = buildItineraries(overnightInput(makeStay()));

		expect(itinerary?.stay).toBeDefined();
		expect(itinerary?.nightsInConnection).toBe(2);
		expect(itinerary?.totalPrice).toEqual({ minorUnits: 22000 + 3000 * 2, currency: 'EUR' });
	});
});

describe('buildItineraries — in-city legs without a bed (issue #161)', () => {
	const outboundArrival = localDateTime('2026-10-06T18:00:00', 'Europe/Vienna', 120);
	const onwardDeparture = localDateTime('2026-10-08T10:00:00', 'Europe/Vienna', 120);

	function stopoverInput(resources: ConnectionResources): BuildItinerariesInput {
		return baseInput({
			outboundOffers: [makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150, 10000)],
			onwardOffers: [makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90, 12000)],
			connectionResources: { VIE: resources },
			waitingTimeRules: flatWaitingTime(60)
		});
	}

	it('keeps a city-centre route on the itinerary even though no bed was priced', () => {
		// The default state of every first visit: no stay-provider key, so no bed, and the
		// ride into town is the whole reason the stopover is worth anything.
		const [itinerary] = buildItineraries(
			stopoverInput({
				transferAnchor: 'city-centre',
				transferToHotel: makeTransfer(25),
				transferToConnectionAirport: makeTransfer(25)
			})
		);

		expect(itinerary?.stay).toBeUndefined();
		expect(itinerary?.transferToHotel?.duration).toBe(25);
		expect(itinerary?.transferToConnectionAirport?.duration).toBe(25);
	});

	it('takes the ride into town off free time, the same as a ride to a hotel would', () => {
		const withRoutes = buildItineraries(
			stopoverInput({
				transferAnchor: 'city-centre',
				transferToHotel: makeTransfer(25),
				transferToConnectionAirport: makeTransfer(25)
			})
		)[0];
		const withNothing = buildItineraries(stopoverInput({}))[0];

		// 25 minutes each way, plus the same 60-minute pre-boarding buffer on both sides.
		expect(withNothing.freeTime.duration - withRoutes.freeTime.duration).toBe(50);
		expect(withRoutes.freeTime.start.local).toBe('2026-10-06T18:25:00');
	});

	it('drops legs that were routed to a bed this itinerary had to discard', () => {
		// Issue #152's currency guard still stands: those two legs end at an address that is
		// no longer part of the trip, unlike a city-centre route, which stands on its own.
		const usd: Stay = { ...makeStay(), pricePerNight: { minorUnits: 4000, currency: 'USD' } };
		const [itinerary] = buildItineraries(
			stopoverInput({
				stay: usd,
				transferAnchor: 'stay',
				transferToHotel: makeTransfer(25),
				transferToConnectionAirport: makeTransfer(25)
			})
		);

		expect(itinerary?.stay).toBeUndefined();
		expect(itinerary?.transferToHotel).toBeUndefined();
		expect(itinerary?.transferToConnectionAirport).toBeUndefined();
	});

	it('keeps free time intact through a waiting-time edit on a bedless itinerary', () => {
		// `recomputeItineraryWaitingTimes` used to read the transfers only when a stay was
		// present, so editing a buffer on one of these itineraries would have silently
		// handed the ride into town back as free time.
		const [itinerary] = buildItineraries(
			stopoverInput({
				transferAnchor: 'city-centre',
				transferToHotel: makeTransfer(25),
				transferToConnectionAirport: makeTransfer(25)
			})
		);
		const edited = recomputeItineraryWaitingTimes(itinerary, { connectionWaitingTime: 90 as Duration });

		expect(edited.freeTime.start.local).toBe(itinerary.freeTime.start.local);
		expect(edited.freeTime.duration).toBe(itinerary.freeTime.duration - 30);
	});
});

describe('buildItineraries — a short overnight is a wait, not a stay (issue #231)', () => {
	/** Land late, leave before dawn, with half an hour of ground transfer at each end and a
	 * two-hour airport buffer, which is what the app assumes everywhere. */
	function overnight(arrivalLocal: string, departureLocal: string) {
		const arrival = localDateTime(arrivalLocal, 'Europe/London', 60);
		const departure = localDateTime(departureLocal, 'Europe/London', 60);
		return buildItineraries(
			baseInput({
				outboundOffers: [makeFlight('LGW', 'VIE', arrival, arrival, 150, 5000)],
				onwardOffers: [makeFlight('VIE', 'IST', departure, departure, 90, 6000)],
				connectionResources: {
					VIE: {
						stay: makeStay(3000),
						transferToHotel: makeTransfer(30),
						transferToConnectionAirport: makeTransfer(30)
					}
				},
				waitingTimeRules: flatWaitingTime(120)
			})
		)[0];
	}

	it('charges no room for six hours between 11pm and 5am', () => {
		// Land 11pm, board at 3am. The clock crosses a date, so before this rule the total
		// carried a night nobody would have checked in for.
		const itinerary = overnight('2026-10-06T23:00:00', '2026-10-07T05:00:00');

		expect(itinerary.nightsInConnection).toBe(0);
		// Flights only: 5000 + 6000, with no 3000 bed folded in.
		expect(itinerary.totalPrice.minorUnits).toBe(11000);
		// Issue #365: with no night there is no bed, so the two half-hour rides to and from
		// one are not part of this trip and the window runs runway to runway. Until this
		// landed it read 11:30pm to 2:30am, an hour of it spent travelling to a hostel the
		// traveller never checks into.
		expect(itinerary.transferToHotel).toBeUndefined();
		expect(itinerary.transferToConnectionAirport).toBeUndefined();
		expect(itinerary.freeTime.start.local).toBe('2026-10-06T23:00:00');
		expect(itinerary.freeTime.end.local).toBe('2026-10-07T03:00:00');
	});

	it('counts a stopover nobody can leave the airport for as airport waiting, not free time', () => {
		// The owner, on the same card: "free time should not be free time, it should become
		// waiting at the airport." Four hours in a terminal between two flights is not a
		// stopover in a city, and the card was printing AIRPORT WAIT beside it as though the
		// two were different time.
		const itinerary = overnight('2026-10-06T23:00:00', '2026-10-07T05:00:00');

		expect(itinerary.freeTime.duration).toBe(240);
		expect(itinerary.times.free).toBe(0);
		// Two 120-minute buffers plus the four hours on the ground between them.
		expect(itinerary.times.airportWaiting).toBe(120 + 120 + 240);
		// Door to door is untouched: those minutes are real either way, and only their name
		// changed.
		expect(itinerary.times.total).toBe(120 + 150 + 240 + 120 + 90);
	});

	it('keeps free time when the ride goes into town rather than to a bed', () => {
		// Issue #161's case, which issue #365 must not touch: no stay priced, both legs
		// anchored to the city centre. A traveller with a long layover really does go into
		// town, and those hours are free time whether or not anyone priced a place to sleep.
		const [itinerary] = buildItineraries(
			baseInput({
				outboundOffers: [
					makeFlight(
						'LGW',
						'VIE',
						localDateTime('2026-10-06T09:00:00', 'Europe/London', 60),
						localDateTime('2026-10-06T09:00:00', 'Europe/London', 60),
						150,
						5000
					)
				],
				onwardOffers: [
					makeFlight(
						'VIE',
						'IST',
						localDateTime('2026-10-06T21:00:00', 'Europe/London', 60),
						localDateTime('2026-10-06T21:00:00', 'Europe/London', 60),
						90,
						6000
					)
				],
				connectionResources: {
					VIE: {
						transferAnchor: 'city-centre',
						transferToHotel: makeTransfer(30),
						transferToConnectionAirport: makeTransfer(30)
					}
				},
				waitingTimeRules: flatWaitingTime(120)
			})
		);

		expect(itinerary?.nightsInConnection).toBe(0);
		expect(itinerary?.transferToHotel?.duration).toBe(30);
		expect(itinerary?.times.free).toBeGreaterThan(0);
	});

	it('still charges the room when the same gap is long enough to sleep in', () => {
		// Land at 9pm, fly out at 11am: at the property 9:30pm until 8:30am.
		const itinerary = overnight('2026-10-06T21:00:00', '2026-10-07T11:00:00');

		expect(itinerary.nightsInConnection).toBe(1);
		expect(itinerary.totalPrice.minorUnits).toBe(14000);
	});

	it('follows a waiting-time edit that turns a night into a wait', () => {
		// Land 8:30pm, fly out 6am. The default buffer leaves the traveller at the property
		// from 9pm until 3:30am, six and a half hours of night, so it is a night. Push the
		// buffer to five hours and they leave at 12:30am, which is not.
		const itinerary = overnight('2026-10-06T20:30:00', '2026-10-07T06:00:00');
		expect(itinerary.nightsInConnection).toBe(1);

		const edited = recomputeItineraryWaitingTimes(itinerary, { connectionWaitingTime: 300 as Duration });
		expect(edited.freeTime.end.local).toBe('2026-10-07T00:30:00');
		expect(edited.nightsInConnection).toBe(0);
		expect(edited.totalPrice.minorUnits).toBe(11000);
	});
});
