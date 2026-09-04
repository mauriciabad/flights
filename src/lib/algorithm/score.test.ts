import { describe, expect, it } from 'vitest';
import type {
	Airport,
	Carrier,
	Duration,
	FlightOffer,
	FreeTime,
	Itinerary,
	LocalDateTime,
	Stay,
	Transfer
} from '../domain';
import { DEFAULT_SCORING_WEIGHTS, rankItineraries, scoreItinerary, usableFreeHours } from './score';

// ---------------------------------------------------------------------------
// Fixture builders — enough of each domain type to be a valid Itinerary, no more.
// ---------------------------------------------------------------------------

function localDateTime(local: string): LocalDateTime {
	// Fixed offset/zone throughout: every test scenario stays inside one connection city,
	// so the zone identity is irrelevant to what's being scored, only the wall clock is.
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function freeTime(startLocal: string, endLocal: string, durationMinutes: number): FreeTime {
	return {
		start: localDateTime(startLocal),
		end: localDateTime(endLocal),
		duration: durationMinutes as Duration
	};
}

const originAirport: Airport = {
	iataCode: 'MAD',
	name: 'Adolfo Suárez Madrid–Barajas',
	coordinates: { latitude: 40.4936, longitude: -3.5668 },
	city: {
		name: 'Madrid',
		coordinates: { latitude: 40.4168, longitude: -3.7038 },
		country: { isoCode: 'ES', name: 'Spain' }
	},
	country: { isoCode: 'ES', name: 'Spain' },
	sizeClass: 'large'
};

const connectionAirport: Airport = {
	iataCode: 'VIE',
	name: 'Vienna International Airport',
	coordinates: { latitude: 48.1103, longitude: 16.5697 },
	city: {
		name: 'Vienna',
		coordinates: { latitude: 48.2082, longitude: 16.3738 },
		country: { isoCode: 'AT', name: 'Austria' }
	},
	country: { isoCode: 'AT', name: 'Austria' },
	sizeClass: 'large'
};

const destinationAirport: Airport = {
	iataCode: 'TLL',
	name: 'Tallinn Airport',
	coordinates: { latitude: 59.4133, longitude: 24.8328 },
	city: {
		name: 'Tallinn',
		coordinates: { latitude: 59.437, longitude: 24.7536 },
		country: { isoCode: 'EE', name: 'Estonia' }
	},
	country: { isoCode: 'EE', name: 'Estonia' },
	sizeClass: 'medium'
};

function carrier(iataCode: string, name: string): Carrier {
	return { iataCode, name };
}

function flight(
	departureAirport: string,
	arrivalAirport: string,
	departure: string,
	arrival: string,
	durationMinutes: number,
	flightCarrier: Carrier
): FlightOffer {
	return {
		carrier: flightCarrier,
		flightNumber: `${flightCarrier.iataCode}100`,
		departureAirport,
		arrivalAirport,
		departure: localDateTime(departure),
		arrival: localDateTime(arrival),
		duration: durationMinutes as Duration,
		price: { minorUnits: 8000, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

function transfer(durationMinutes: number): Transfer {
	return { mode: 'walk', duration: durationMinutes as Duration, legs: [] };
}

const stay: Stay = {
	property: {
		name: 'Test Hostel',
		coordinates: { latitude: 48.2082, longitude: 16.3738 },
		images: []
	},
	roomKind: 'private',
	pricePerNight: { minorUnits: 4000, currency: 'EUR' }
};

/**
 * A short, near-midday layover: 2 hours of free time, no night spent in the connection
 * city. Total price and travel overhead are held equal to threeNightStopover below except
 * for the eight-euro difference the brief itself uses as its example, so the only thing
 * that should be deciding the ranking between the two is the stopover itself.
 */
function twoHourLayover(flightCarrier: Carrier = carrier('AB', 'Air Baseline')): Itinerary {
	return {
		originAirport,
		originWaitingTime: 120 as Duration,
		outboundFlight: flight('MAD', 'VIE', '2026-09-10T08:00:00', '2026-09-10T10:30:00', 150, flightCarrier),
		transferToHotel: transfer(15),
		stay,
		freeTime: freeTime('2026-09-10T11:00:00', '2026-09-10T13:00:00', 120),
		nightsInConnection: 0,
		transferToConnectionAirport: transfer(15),
		connectionWaitingTime: 120 as Duration,
		onwardFlight: flight('VIE', 'TLL', '2026-09-10T15:00:00', '2026-09-10T17:30:00', 150, flightCarrier),
		destinationAirport,
		totalPrice: { minorUnits: 20000, currency: 'EUR' },
		travellers: 1,
		times: {
			inFlight: 300 as Duration, // both flights: 150 + 150
			airportWaiting: 240 as Duration, // originWaitingTime + connectionWaitingTime
			free: 120 as Duration,
			total: 690 as Duration // inFlight + airportWaiting + free + 2*15min transfers
		}
	};
}

/**
 * The brief's own example: nearly the same trip, eight euros more, but with three nights
 * actually spent in Vienna instead of a two-hour layover. Travel overhead (everything but
 * free time) is identical to twoHourLayover above, isolating nights + usable free time as
 * the only meaningful difference.
 */
function threeNightStopover(flightCarrier: Carrier = carrier('AB', 'Air Baseline')): Itinerary {
	return {
		originAirport,
		originWaitingTime: 120 as Duration,
		outboundFlight: flight('MAD', 'VIE', '2026-09-10T08:00:00', '2026-09-10T10:30:00', 150, flightCarrier),
		transferToHotel: transfer(15),
		stay,
		freeTime: freeTime('2026-09-10T11:00:00', '2026-09-13T11:00:00', 4320),
		nightsInConnection: 3,
		transferToConnectionAirport: transfer(15),
		connectionWaitingTime: 120 as Duration,
		onwardFlight: flight('VIE', 'TLL', '2026-09-13T15:00:00', '2026-09-13T17:30:00', 150, flightCarrier),
		destinationAirport,
		totalPrice: { minorUnits: 20800, currency: 'EUR' }, // 8 EUR more, per the brief's own example
		travellers: 1,
		times: {
			inFlight: 300 as Duration,
			airportWaiting: 240 as Duration,
			free: 4320 as Duration,
			total: 4890 as Duration // inFlight + airportWaiting + free + 2*15min transfers
		}
	};
}

describe('usableFreeHours', () => {
	it('scores a 03:00-07:00 window far below a same-length daytime window', () => {
		const badNight = freeTime('2026-09-10T03:00:00', '2026-09-10T07:00:00', 240);
		const goodDay = freeTime('2026-09-10T10:00:00', '2026-09-10T14:00:00', 240);

		const nightUsable = usableFreeHours(badNight);
		const dayUsable = usableFreeHours(goodDay);

		expect(nightUsable).toBeLessThan(0.5);
		expect(dayUsable).toBeGreaterThan(3.9);
		expect(dayUsable).toBeGreaterThan(nightUsable);
	});

	it('returns zero for a window that ends before it starts', () => {
		const invalid = freeTime('2026-09-10T14:00:00', '2026-09-10T10:00:00', 0);
		expect(usableFreeHours(invalid)).toBe(0);
	});

	it('accumulates across multiple days for a long stopover', () => {
		const oneDay = freeTime('2026-09-10T09:00:00', '2026-09-11T09:00:00', 1440);
		const threeDays = freeTime('2026-09-10T09:00:00', '2026-09-13T09:00:00', 4320);

		// Roughly 3x, not exactly, since the curve isn't a flat rate across a day.
		expect(usableFreeHours(threeDays)).toBeGreaterThan(usableFreeHours(oneDay) * 2.5);
	});
});

describe('scoreItinerary / rankItineraries', () => {
	it('ranks a 3-night stopover above a 2-hour layover at near-equal price', () => {
		const layover = scoreItinerary(twoHourLayover());
		const stopover = scoreItinerary(threeNightStopover());

		expect(stopover.total).toBeGreaterThan(layover.total);
		// The nights bonus alone should be doing the heavy lifting here, not a fluke of
		// the other components.
		expect(stopover.breakdown.nights).toBeGreaterThan(0);
		expect(stopover.breakdown.nights).toBeGreaterThan(
			Math.abs(stopover.breakdown.price - layover.breakdown.price)
		);
	});

	it('ranks a long stopover above a short layover on the nights bonus alone, with no stay priced at all (issue #105)', () => {
		// Exactly the app's default, keyless first-time-visitor state: no stay provider had
		// a key, so `stay` and its transfers are all `undefined` on both itineraries — the
		// nights bonus must still fire from the flight schedule alone.
		const layover: Itinerary = {
			...twoHourLayover(),
			stay: undefined,
			transferToHotel: undefined,
			transferToConnectionAirport: undefined
		};
		const stopover: Itinerary = {
			...threeNightStopover(),
			stay: undefined,
			transferToHotel: undefined,
			transferToConnectionAirport: undefined
		};

		const layoverScore = scoreItinerary(layover);
		const stopoverScore = scoreItinerary(stopover);

		expect(stopoverScore.total).toBeGreaterThan(layoverScore.total);
		expect(stopoverScore.breakdown.nights).toBeGreaterThan(0);
		expect(stopoverScore.breakdown.nights).toBeGreaterThan(
			Math.abs(stopoverScore.breakdown.price - layoverScore.breakdown.price)
		);
	});

	it('never drops an avoided-airline itinerary, but ranks it lower', () => {
		const clean = twoHourLayover(carrier('AB', 'Air Baseline'));
		const avoided = twoHourLayover(carrier('XX', 'Skip Air'));

		const ranked = rankItineraries([clean, avoided], ['XX']);

		expect(ranked).toHaveLength(2);
		expect(ranked.map((r) => r.itinerary)).toContain(clean);
		expect(ranked.map((r) => r.itinerary)).toContain(avoided);

		const cleanScore = ranked.find((r) => r.itinerary === clean)!;
		const avoidedScore = ranked.find((r) => r.itinerary === avoided)!;

		expect(avoidedScore.avoidedAirlineFlightCount).toBe(2); // both legs on 'XX'
		expect(cleanScore.avoidedAirlineFlightCount).toBe(0);
		expect(avoidedScore.total).toBeLessThan(cleanScore.total);
		// Best-first: the clean itinerary must sort ahead of the avoided one.
		expect(ranked[0].itinerary).toBe(clean);
	});

	it('applies the avoided-airline penalty only when a flight actually matches', () => {
		const scored = scoreItinerary(twoHourLayover(carrier('AB', 'Air Baseline')), ['ZZ']);
		expect(scored.avoidedAirlineFlightCount).toBe(0);
		expect(scored.breakdown.avoidedAirline).toBe(0);
	});

	it('every weight in DEFAULT_SCORING_WEIGHTS is a finite positive number', () => {
		for (const [key, value] of Object.entries(DEFAULT_SCORING_WEIGHTS)) {
			expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
			expect(value, `${key} should be positive`).toBeGreaterThan(0);
		}
	});
});
