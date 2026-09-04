import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Money } from '../domain';
import { MIN_SHARE, clampedShares, tripStrip } from './trip-strip';

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function airport(iataCode: string): Airport {
	const city = { name: iataCode, coordinates: { latitude: 0, longitude: 0 }, country: { isoCode: 'XX', name: 'X' } };
	return {
		iataCode,
		name: `${iataCode} Airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country: city.country,
		sizeClass: 'medium'
	};
}

const eur = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

function flight(from: string, to: string, departure: string, arrival: string, minutes: number): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber: 'FR100',
		departureAirport: from,
		arrivalAirport: to,
		departure: at(departure),
		arrival: at(arrival),
		duration: minutes as Duration,
		price: eur(9000),
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

/** Outbound lands, then a stopover of `stopoverMinutes`, then the onward flight. */
function makeItinerary(outboundMinutes: number, stopoverMinutes: number, onwardMinutes: number): Itinerary {
	const departure = new Date('2026-10-06T08:00:00Z');
	const landing = new Date(departure.getTime() + outboundMinutes * 60_000);
	const onwardDeparture = new Date(landing.getTime() + stopoverMinutes * 60_000);
	const onwardArrival = new Date(onwardDeparture.getTime() + onwardMinutes * 60_000);
	const iso = (date: Date) => date.toISOString().slice(0, 19);

	const outboundFlight = flight('BVC', 'LGW', iso(departure), iso(landing), outboundMinutes);
	const onwardFlight = flight('LGW', 'PFO', iso(onwardDeparture), iso(onwardArrival), onwardMinutes);

	return {
		originAirport: airport('BVC'),
		originWaitingTime: 120 as Duration,
		outboundFlight,
		freeTime: { start: at(iso(landing)), end: at(iso(onwardDeparture)), duration: stopoverMinutes as Duration },
		nightsInConnection: 0,
		connectionWaitingTime: 120 as Duration,
		onwardFlight,
		destinationAirport: airport('PFO'),
		totalPrice: eur(18000),
		travellers: 1,
		times: {
			inFlight: (outboundMinutes + onwardMinutes) as Duration,
			airportWaiting: 240 as Duration,
			free: stopoverMinutes as Duration,
			total: (outboundMinutes + stopoverMinutes + onwardMinutes) as Duration
		}
	};
}

describe('clampedShares', () => {
	it('keeps the shape of the proportions after the baseline is taken out', () => {
		// 0.1 each as a baseline, the remaining 0.7 split 1:1:2.
		const shares = clampedShares([1, 1, 2]);
		expect(shares[0]).toBeCloseTo(0.275, 10);
		expect(shares[1]).toBeCloseTo(0.275, 10);
		expect(shares[2]).toBeCloseTo(0.45, 10);
	});

	it('always sums to one, whatever the ratio', () => {
		for (const weights of [[1, 1, 1], [120, 4320, 185], [5, 5, 500], [0, 100, 0], [1, 0, 0]]) {
			const total = clampedShares(weights).reduce((sum, share) => sum + share, 0);
			expect(total).toBeCloseTo(1, 10);
		}
	});

	it('never lets a span fall below the floor, which is what keeps a short flight visible', () => {
		// The real case this exists for: a two-hour flight beside a three-day stopover is a
		// 1:36 ratio, which renders as a four-pixel sliver on a phone.
		const shares = clampedShares([120, 4320, 185]);
		for (const share of shares) expect(share).toBeGreaterThanOrEqual(MIN_SHARE - 1e-9);
	});

	it('still ranks the spans strictly, even when every one of them is under the floor', () => {
		// The reason this is a baseline plus a remainder rather than a clamp: under a
		// clamp both flights here land on the floor exactly and a 2h hop looks identical
		// to a 3h one.
		const [first, second, third] = clampedShares([120, 4320, 185]);
		expect(second).toBeGreaterThan(third);
		expect(third).toBeGreaterThan(first);
	});

	it('splits evenly rather than dividing by zero when nothing has any length', () => {
		for (const share of clampedShares([0, 0, 0])) expect(share).toBeCloseTo(1 / 3, 10);
	});
});

describe('tripStrip', () => {
	it('measures the stopover between the two flights own clocks', () => {
		const strip = tripStrip(makeItinerary(120, 4320, 185));
		expect(strip.spans.map((span) => span.minutes)).toEqual([120, 4320, 185]);
		expect(strip.totalMinutes).toBe(120 + 4320 + 185);
	});

	it('names the airports at each span boundary from the flights themselves', () => {
		const strip = tripStrip(makeItinerary(120, 300, 185));
		expect(strip.spans.map((span) => [span.from, span.to])).toEqual([
			['BVC', 'LGW'],
			['LGW', 'LGW'],
			['LGW', 'PFO']
		]);
	});

	it('reports a same-airport turnaround with no measurable gap as zero, never a negative', () => {
		// `minutesBetween` can go negative on data where the onward flight is timetabled
		// before the outbound lands. That is a pipeline problem, not something this strip
		// should render as a bar pointing backwards.
		const itinerary = makeItinerary(120, 300, 185);
		const broken: Itinerary = {
			...itinerary,
			onwardFlight: { ...itinerary.onwardFlight, departure: itinerary.outboundFlight.departure }
		};
		expect(tripStrip(broken).spans[1].minutes).toBe(0);
	});
});
