import { describe, expect, it } from 'vitest';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	LocalDateTime,
	Stay,
	Transfer,
	WaitingTimeRule
} from '../domain';
import { buildItineraries, recomputeItineraryWaitingTimes, type BuildItinerariesInput } from './build';

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
	priceMinorUnits = 5000
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR1',
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
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

	it('never guesses a stay cost or a night count when no stay was found', () => {
		const arrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
		// A gap wide enough to cross a calendar date, so a bug that still consulted
		// `nightsBetween` here (rather than hard-zeroing it) would show up as a nonzero
		// night count instead of silently matching by coincidence.
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

		expect(itinerary.nightsInConnection).toBe(0);
		// Total is exactly the two flights, no hotel and no in-city transfer legs — never a
		// $0 stay standing in for "unknown".
		expect(itinerary.totalPrice).toEqual({ minorUnits: outbound.price.minorUnits + onward.price.minorUnits, currency: 'EUR' });
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
