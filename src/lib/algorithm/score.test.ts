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
import {
	DEFAULT_SCORING_WEIGHTS,
	moneyCostOf,
	nightBonus,
	rankItineraries,
	scoreItinerary,
	usableFreeHours
} from './score';

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
			connectionAirportWaiting: 120 as Duration,
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
			connectionAirportWaiting: 120 as Duration,
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

// ---------------------------------------------------------------------------
// Issue #167: the night bonus used to be `nightBonusPerNight * nights`, unbounded, and a
// stopover with no priced bed was charged nothing at all for its nights. Together those
// made "more nights" a strict, permanent improvement, and once #166 gave every stopover a
// month of dated fares to choose between, the top result on BCN -> OTP became a 24-night
// stay. These tests pin the two properties that stop that: the value of a stopover
// saturates, and a night nobody priced is not a free night.
// ---------------------------------------------------------------------------

/**
 * A stopover of exactly `nights` calendar nights, 11:00 to 11:00, holding everything else
 * equal: same flights, same durations, same airport waiting. `bedPerNight` is the stay's
 * nightly rate in minor units, or `undefined` for the keyless default state where no bed
 * was priced at all; `totalPrice` follows from it the same way `build.ts` computes it, so
 * these itineraries are the ones the real builder would have produced.
 */
function nightsStopover(nights: number, bedPerNight?: number): Itinerary {
	const departDay = 10 + nights;
	const freeDuration = nights * 24 * 60;
	const bedTotal = bedPerNight === undefined ? 0 : bedPerNight * nights;
	const stayForNights: Stay | undefined =
		bedPerNight === undefined
			? undefined
			: { ...stay, pricePerNight: { minorUnits: bedPerNight, currency: 'EUR' } };
	const departLocal = `2026-09-${String(departDay).padStart(2, '0')}`;
	return {
		originAirport,
		originWaitingTime: 120 as Duration,
		outboundFlight: flight('MAD', 'VIE', '2026-09-10T08:00:00', '2026-09-10T10:30:00', 150, carrier('AB', 'Air Baseline')),
		transferToHotel: stayForNights && transfer(15),
		stay: stayForNights,
		freeTime: freeTime('2026-09-10T11:00:00', `${departLocal}T11:00:00`, freeDuration),
		nightsInConnection: nights,
		transferToConnectionAirport: stayForNights && transfer(15),
		connectionWaitingTime: 120 as Duration,
		onwardFlight: flight('VIE', 'TLL', `${departLocal}T15:00:00`, `${departLocal}T17:30:00`, 150, carrier('AB', 'Air Baseline')),
		destinationAirport,
		totalPrice: { minorUnits: 20000 + bedTotal, currency: 'EUR' },
		travellers: 1,
		times: {
			inFlight: 300 as Duration,
			airportWaiting: 240 as Duration,
			connectionAirportWaiting: 120 as Duration,
			free: freeDuration as Duration,
			total: (300 + 240 + freeDuration + 30) as Duration
		}
	};
}

describe('the night bonus saturates (issue #167)', () => {
	it('pays less for each further night, and never more than its ceiling', () => {
		const { firstNightBonus, stopoverDecayPerNight } = DEFAULT_SCORING_WEIGHTS;
		const bonus = (n: number) => nightBonus(n, firstNightBonus, stopoverDecayPerNight);

		expect(bonus(0)).toBe(0);
		expect(bonus(1)).toBeCloseTo(firstNightBonus, 6);

		// Every marginal night is worth strictly less than the one before it, which is the
		// whole shape: two nights is much better than one, ten is barely better than eight.
		const marginal = (n: number) => bonus(n) - bonus(n - 1);
		for (let n = 3; n <= 30; n++) {
			expect(marginal(n)).toBeLessThan(marginal(n - 1));
			expect(marginal(n)).toBeGreaterThan(0);
		}
		expect(marginal(2)).toBeGreaterThan(20); // the second night still counts for something
		expect(marginal(10)).toBeLessThan(5); // the tenth barely does

		const ceiling = firstNightBonus / (1 - stopoverDecayPerNight);
		expect(bonus(1000)).toBeLessThanOrEqual(ceiling);
		expect(bonus(1000)).toBeCloseTo(ceiling, 3);
	});

	it('ranks a 24-night stopover below a 3-night one when no bed was priced', () => {
		// The exact production symptom: BCN -> OTP, no stay-provider key, the scorer picking
		// the longest stay the search window allowed. Under the old flat 40-a-night bonus
		// this assertion is false by roughly 800 points.
		const long = scoreItinerary(nightsStopover(24));
		const short = scoreItinerary(nightsStopover(3));

		expect(short.total).toBeGreaterThan(long.total);
		expect(rankItineraries([nightsStopover(24), nightsStopover(3)])[0].itinerary.nightsInConnection).toBe(3);
	});

	it('stops rewarding extra nights even when the bed itself is priced at zero', () => {
		// A zero-priced room is a provider defect, not a free room. If it were taken at face
		// value nothing would charge for those nights and the runaway would return through
		// the one gap a saturating bonus leaves: a curve that still creeps upward forever.
		const long = scoreItinerary(nightsStopover(24, 0));
		const short = scoreItinerary(nightsStopover(3, 0));

		expect(short.total).toBeGreaterThan(long.total);
		expect(long.breakdown.unpricedNights).toBeLessThan(0);
	});

	it('still prefers a real stopover to a same-day layover', () => {
		// The fix must not overshoot into "no stopover is best", which would defeat the
		// entire product thesis. Three nights with no bed priced still beats a 2h layover.
		const stopover = scoreItinerary(nightsStopover(3));
		const layover = scoreItinerary({
			...twoHourLayover(),
			stay: undefined,
			transferToHotel: undefined,
			transferToConnectionAirport: undefined
		});

		expect(stopover.total).toBeGreaterThan(layover.total);
	});
});

describe('an unpriced bed is unknown, not free (issue #167)', () => {
	it('ranks an unpriced stopover below an identical one with a real bed', () => {
		// Same flights, same nights, same everything — one has a EUR 23/night hostel bed
		// (the rate in the captured Agoda London fixture), the other has no bed priced at
		// all, so its total looks EUR 69 cheaper. The cheaper-looking one must not win.
		const priced = nightsStopover(3, 2300);
		const unpriced = nightsStopover(3);

		expect(unpriced.totalPrice.minorUnits).toBeLessThan(priced.totalPrice.minorUnits);
		expect(scoreItinerary(priced).total).toBeGreaterThan(scoreItinerary(unpriced).total);
		expect(rankItineraries([unpriced, priced])[0].itinerary).toBe(priced);
	});

	it('charges nothing for nights when a bed was priced, and nothing for a same-day connection', () => {
		expect(scoreItinerary(nightsStopover(3, 2300)).breakdown.unpricedNights).toBe(0);
		// Zero nights means no bed is missing — nothing to assume a cost for.
		expect(scoreItinerary(twoHourLayover()).breakdown.unpricedNights).toBe(0);
		const sameDayNoStay: Itinerary = {
			...twoHourLayover(),
			stay: undefined,
			transferToHotel: undefined,
			transferToConnectionAirport: undefined
		};
		expect(scoreItinerary(sameDayNoStay).breakdown.unpricedNights).toBe(0);
	});

	it('charges the stated assumed rate per unpriced night', () => {
		const scored = scoreItinerary(nightsStopover(4));
		expect(scored.breakdown.unpricedNights).toBeCloseTo(
			-4 * DEFAULT_SCORING_WEIGHTS.assumedNightCostWithoutPricedBed,
			6
		);
	});
});

describe('free time earns diminishing returns too (issue #167)', () => {
	it('does not keep paying full price for the twentieth afternoon in the same city', () => {
		// Decaying the night bonus alone would have left this term unbounded: roughly 15
		// usable hours per extra day at 1.5 points each, about 22 points a night, forever.
		const six = scoreItinerary(nightsStopover(6)).breakdown.usableFreeTime;
		const twentyFour = scoreItinerary(nightsStopover(24)).breakdown.usableFreeTime;

		expect(twentyFour).toBeGreaterThan(six);
		// Four times the nights, nowhere near four times the credit.
		expect(twentyFour).toBeLessThan(six * 1.3);
	});

	it('leaves the undiscounted usableFreeHours alone, since the UI reports it as a fact', () => {
		// The UI reports this as a plain count of hours in the stopover, not as a scoring
		// opinion, so it must not decay the way the ranking credit for those hours does.
		const oneDay = freeTime('2026-09-10T09:00:00', '2026-09-11T09:00:00', 1440);
		const fourDays = freeTime('2026-09-10T09:00:00', '2026-09-14T09:00:00', 5760);
		expect(usableFreeHours(fourDays)).toBeGreaterThan(usableFreeHours(oneDay) * 3.5);
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

	// -----------------------------------------------------------------------
	// Issue #204: an unpriced ride is not a free ride
	// -----------------------------------------------------------------------

	/**
	 * The owner's own complaint, reduced to two candidates for the same stopover.
	 *
	 * He searched a trip connecting through Gatwick and got beds far out in London while
	 * Horley, a 40-minute walk from the terminal, sat there unoffered: "the hotels found
	 * are TOO FAR away to be an acceptable result... and the price of transport should be
	 * considered as well and you are not doing it".
	 *
	 * `nearBed` is Horley: EUR 60 a night, and you walk (3.3km from the terminal, which
	 * OSRM's foot profile puts around 40 minutes). `farBed` is central London: EUR 32 a
	 * night, and it is two 45-minute taxi rides nobody has quoted a fare for (40.1km, both
	 * measured in `search/resources.ts`'s own radius table).
	 *
	 * The nightly rates are approximate real ones for that pair of places, not figures
	 * chosen to make this pass: an airport-town chain hotel against a central-London
	 * hostel dorm. Over three nights the far bed is EUR 84 cheaper on paper, which is why
	 * it used to win, and several hundred more expensive once two 40km taxi rides are
	 * counted (the GB card in `providers/transfers/taxi-rate-table.ts` puts one of them at
	 * GBP 115 to 183).
	 *
	 * Everything else is held identical, so the ranking turns on the rides alone.
	 */
	function bedAtDistance(pricePerNightMinorUnits: number, connectionTransfer: Transfer): Itinerary {
		const base = threeNightStopover();
		return {
			...base,
			stay: { ...stay, pricePerNight: { minorUnits: pricePerNightMinorUnits, currency: 'EUR' } },
			transferToHotel: connectionTransfer,
			transferToConnectionAirport: connectionTransfer,
			totalPrice: { minorUnits: 16000 + pricePerNightMinorUnits * 3, currency: 'EUR' }
		};
	}

	const walkToBed: Transfer = { mode: 'walk', duration: 40 as Duration, legs: [] };
	const taxiToBed: Transfer = { mode: 'taxi', duration: 45 as Duration, legs: [] };

	it('ranks a walkable bed above a cheaper one that needs two taxis nobody priced', () => {
		const nearBed = bedAtDistance(6000, walkToBed); // Horley: EUR 60/night, on foot
		const farBed = bedAtDistance(3200, taxiToBed); // London: EUR 32/night, two taxis

		// The defect, stated as an assertion: on quoted money alone the far bed wins by
		// EUR 84, and `totalPrice` is still allowed to say exactly that. It is a real
		// number, it is just not the whole trip.
		expect(farBed.totalPrice.minorUnits).toBeLessThan(nearBed.totalPrice.minorUnits);

		const ranked = rankItineraries([farBed, nearBed]);

		expect(ranked[0]!.itinerary).toBe(nearBed);
		expect(ranked[0]!.breakdown.unpricedTransfers).toBe(0);
		expect(ranked[1]!.breakdown.unpricedTransfers).toBeLessThan(0);
	});

	it('is a floor on an unknown, so a dramatically cheaper bed still wins', () => {
		// The honest limit of what this charge does, asserted rather than left to be
		// discovered. Two 45-minute rides are charged 2 * (3 + 70 * 0.75) = 111, and a bed
		// EUR 50 a night cheaper over three nights is EUR 150 ahead. The far one wins, and
		// should: the app does not know what those rides cost, and a charge big enough to
		// overrule any gap would be a penalty wearing an estimate's clothes.
		const nearBed = bedAtDistance(7000, walkToBed);
		const farBed = bedAtDistance(2000, taxiToBed);

		expect(rankItineraries([nearBed, farBed])[0]!.itinerary).toBe(farBed);
	});

	it('charges nothing for a walk, because walking really is free', () => {
		// The distinction `domain/transfer.ts`'s `costIsUnknown` exists to keep: an absent
		// price on a walk is a fact this app knows, not a gap in what a provider told it.
		// Charging it would punish the one leg the product most wants to offer.
		expect(scoreItinerary(bedAtDistance(7000, walkToBed)).breakdown.unpricedTransfers).toBe(0);
	});

	it('charges a long unpriced ride more than a short one', () => {
		const shortHop = bedAtDistance(4000, { mode: 'taxi', duration: 10 as Duration, legs: [] });
		const longRun = bedAtDistance(4000, { mode: 'taxi', duration: 45 as Duration, legs: [] });

		expect(longRun.totalPrice).toEqual(shortHop.totalPrice); // same bed, same quoted money
		expect(scoreItinerary(longRun).breakdown.unpricedTransfers).toBeLessThan(
			scoreItinerary(shortHop).breakdown.unpricedTransfers
		);
		// Both legs, base plus the per-hour road term: 2 * (3 + 70 * 45/60) = 111.
		expect(scoreItinerary(longRun).breakdown.unpricedTransfers).toBeCloseTo(-111, 6);
		// 2 * (3 + 70 * 10/60) = 29.33.
		expect(scoreItinerary(shortHop).breakdown.unpricedTransfers).toBeCloseTo(-29.333, 3);
	});

	it('charges a train into town a ticket, not a meter', () => {
		// A 45-minute transit leg and a 45-minute taxi are the same duration and nothing
		// like the same fare, so only the road term scales with the clock.
		const byTransit = bedAtDistance(4000, { mode: 'transit', duration: 45 as Duration, legs: [] });
		const byTaxi = bedAtDistance(4000, taxiToBed);

		expect(scoreItinerary(byTransit).breakdown.unpricedTransfers).toBeCloseTo(-6, 6); // 2 * 3
		expect(scoreItinerary(byTransit).breakdown.unpricedTransfers).toBeGreaterThan(
			scoreItinerary(byTaxi).breakdown.unpricedTransfers
		);
	});

	/**
	 * The owner's **"no transport hoping to change bus or metro line"**, as four cases.
	 *
	 * `bedAtDistance` puts the same transfer on both the hotel leg and the leg back to the
	 * connection airport, so every figure below is two legs' worth. A one-ride journey is
	 * therefore 2 x 3 = 6 and a two-ride journey 2 x 6 = 12.
	 */
	const directMetro: Transfer = {
		mode: 'transit',
		duration: 45 as Duration,
		legs: [{ mode: 'transit', vehicle: 'Metro', duration: 45 as Duration }]
	};
	const coachThenMetro: Transfer = {
		mode: 'transit',
		duration: 45 as Duration,
		legs: [
			{ mode: 'transit', vehicle: 'Coach', duration: 20 as Duration },
			{ mode: 'transit', vehicle: 'Metro', duration: 25 as Duration }
		]
	};

	it('charges a change of vehicle a second ticket', () => {
		const direct = scoreItinerary(bedAtDistance(4000, directMetro)).breakdown.unpricedTransfers;
		const changing = scoreItinerary(bedAtDistance(4000, coachThenMetro)).breakdown.unpricedTransfers;

		expect(direct).toBeCloseTo(-6, 6);
		expect(changing).toBeCloseTo(-12, 6);
		expect(changing).toBeCloseTo(2 * direct, 6);
	});

	it('charges the walks inside a transit journey nothing', () => {
		// Same distinction `costIsUnknown` draws for a whole leg, applied inside one. The
		// walk to the stop and the walk off at the far end are free, so this journey buys
		// one ticket rather than three.
		const walkRideWalk: Transfer = {
			mode: 'transit',
			duration: 45 as Duration,
			legs: [
				{ mode: 'walk', duration: 8 as Duration },
				{ mode: 'transit', vehicle: 'Metro', duration: 30 as Duration },
				{ mode: 'walk', duration: 7 as Duration }
			]
		};

		const charge = scoreItinerary(bedAtDistance(4000, walkRideWalk)).breakdown.unpricedTransfers;
		expect(charge).toBeCloseTo(-6, 6);
		expect(charge).toBeCloseTo(
			scoreItinerary(bedAtDistance(4000, directMetro)).breakdown.unpricedTransfers,
			6
		);
	});

	it('charges a leg that itemises no rides one fare, not none', () => {
		// The property every other case in this block rests on, since they all pass
		// `legs: []`. OSRM answers with one leg and Transitous with several, but a cached
		// `Transfer` or a provider that itemises nothing must not come out free. Nobody
		// listing the rides is not the same claim as nobody taking one.
		const unlisted: Transfer = { mode: 'transit', duration: 45 as Duration, legs: [] };

		expect(scoreItinerary(bedAtDistance(4000, unlisted)).breakdown.unpricedTransfers).toBeCloseTo(
			-6,
			6
		);
	});

	it('leaves a taxi meter alone however many legs the ride is cut into', () => {
		// A taxi that changes cars has still covered the same ground, so only the ticket
		// half of the charge counts vehicles. One leg is 2 * (3 + 70 * 0.75) = 111 and two
		// legs is 2 * (6 + 52.5) = 117, six apart, which is exactly the extra fare.
		const oneCar: Transfer = {
			...taxiToBed,
			legs: [{ mode: 'taxi', duration: 45 as Duration }]
		};
		const twoCars: Transfer = {
			...taxiToBed,
			legs: [
				{ mode: 'taxi', duration: 20 as Duration },
				{ mode: 'taxi', duration: 25 as Duration }
			]
		};

		const oneCarCharge = scoreItinerary(bedAtDistance(4000, oneCar)).breakdown.unpricedTransfers;
		const twoCarCharge = scoreItinerary(bedAtDistance(4000, twoCars)).breakdown.unpricedTransfers;

		expect(oneCarCharge).toBeCloseTo(-111, 6);
		expect(twoCarCharge).toBeCloseTo(-117, 6);
		expect(oneCarCharge - twoCarCharge).toBeCloseTo(
			2 * DEFAULT_SCORING_WEIGHTS.assumedUnpricedTransferBaseCost,
			6
		);
	});

	it('stops charging a leg the moment a provider does quote it', () => {
		const quoted: Transfer = { ...taxiToBed, price: { minorUnits: 4500, currency: 'EUR' } };
		expect(scoreItinerary(bedAtDistance(4000, quoted)).breakdown.unpricedTransfers).toBe(0);
	});

	it('never lets the charge reach totalPrice', () => {
		// The same separation `assumedNightCostWithoutPricedBed` keeps: the ranking may act
		// on an assumption, the price a traveller reads may not. AGENTS.md, "never present
		// an estimate as a fact".
		const farBed = bedAtDistance(2500, taxiToBed);
		expect(scoreItinerary(farBed).itinerary.totalPrice).toEqual(farBed.totalPrice);
	});

	it('every weight in DEFAULT_SCORING_WEIGHTS is a finite positive number', () => {
		for (const [key, value] of Object.entries(DEFAULT_SCORING_WEIGHTS)) {
			expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
			expect(value, `${key} should be positive`).toBeGreaterThan(0);
		}
	});
});

describe('moneyCostOf (issue #364)', () => {
	it('is the quoted total when every night has a priced bed', () => {
		// 20000 minor units of flights plus two nights at 3000, in major units.
		expect(moneyCostOf(scoreItinerary(nightsStopover(2, 3000)))).toBeCloseTo(260, 6);
	});

	it('charges the nights no provider priced, so an unknown bed is not a free one', () => {
		// The same two nights with nothing quoted for them: the total says 200 and the
		// comparison says 200 + 2 x `assumedNightCostWithoutPricedBed`. Without this a
		// three-night pairing would beat a same-day one purely because the app never
		// learned what three beds cost, which is the app being paid for its own ignorance.
		const unpriced = moneyCostOf(scoreItinerary(nightsStopover(2)));
		expect(unpriced).toBeCloseTo(200 + 2 * DEFAULT_SCORING_WEIGHTS.assumedNightCostWithoutPricedBed, 6);
	});

	it('ignores everything the app merely has an opinion about', () => {
		// Two trips of the same length and price, one of them scoring far better on free
		// time. Choosing a stopover length is about money; issue #230 took the app's opinion
		// about how good a trip is out of that choice and this keeps it out.
		const trip = nightsStopover(2, 3000);
		const sameMoneyWorseHours = {
			...trip,
			freeTime: freeTime('2026-09-10T23:00:00', '2026-09-12T03:00:00', 2 * 24 * 60)
		};

		expect(scoreItinerary(sameMoneyWorseHours).total).toBeLessThan(scoreItinerary(trip).total);
		expect(moneyCostOf(scoreItinerary(sameMoneyWorseHours))).toBe(moneyCostOf(scoreItinerary(trip)));
	});
});
