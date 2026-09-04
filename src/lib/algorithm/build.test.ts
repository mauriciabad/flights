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
import { buildItineraries, type BuildItinerariesInput } from './build';

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
