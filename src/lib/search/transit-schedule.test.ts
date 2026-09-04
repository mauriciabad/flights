/**
 * Issue #135: the questions this module asks a timetable, and what it does with the answers.
 *
 * The defect these guard against is not subtle once it is written down — the app asked
 * `time=<the moment you pressed search>&arriveBy=false` for every leg of every trip — but it
 * survived because nothing anywhere asserted what went on the wire. So these tests read the
 * query, not the rendering.
 */

import { describe, expect, it } from 'vitest';
import { buildItineraries } from '../algorithm/build';
import type { BuildItinerariesInput } from '../algorithm/build';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	Itinerary,
	LocalDateTime,
	Stay,
	Transfer
} from '../domain';
import type { ProviderContext, ProviderId, ProviderResult, TransferProvider, TransferSearchQuery } from '../providers/types';
import { SourceTracker } from './provenance';
import {
	createTransitLookupBudget,
	createUnboundedTransitLookupBudget,
	fetchTransitSchedules,
	planTransitLegs
} from './transit-schedule';

const country: Country = { isoCode: 'ES', name: 'Spain' };
const city: City = { name: 'Barcelona', coordinates: { latitude: 41.38, longitude: 2.17 }, country };

function airport(iataCode: string, latitude: number, longitude: number): Airport {
	return { iataCode, name: `${iataCode} airport`, coordinates: { latitude, longitude }, city, country, sizeClass: 'large' };
}

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 };
}

function flight(departure: LocalDateTime, arrival: LocalDateTime, from: string, to: string): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber: 'FR3143',
		departureAirport: from,
		arrivalAirport: to,
		departure,
		arrival,
		duration: 120 as Duration,
		price: { minorUnits: 5000, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

const stay: Stay = {
	property: { name: 'Stopover hostel', coordinates: { latitude: 45.69, longitude: 9.67 }, images: [] },
	roomKind: 'dorm',
	pricePerNight: { minorUnits: 3000, currency: 'EUR' }
};

const CONNECTION_COORDINATES = { latitude: 45.6689, longitude: 9.7 };

/** The issue's own trip: BCN to BGY to OTP, outbound Sunday 4 October at 08:15 with a two
 * hour airport buffer, onward landing at Bucharest on the 14th at 19:25. */
function tripItinerary(options: { withStay?: boolean } = {}): Itinerary {
	const origin = airport('BCN', 41.2971, 2.07846);
	const connection = airport('BGY', 45.6689, 9.7);
	const destination = airport('OTP', 44.5718, 26.1033);

	const input: BuildItinerariesInput = {
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [flight(at('2026-10-04T08:15:00'), at('2026-10-04T10:15:00'), 'BCN', 'BGY')],
		onwardOffers: [flight(at('2026-10-14T17:25:00'), at('2026-10-14T19:25:00'), 'BGY', 'OTP')],
		connectionAirports: { BGY: connection },
		connectionResources: {
			BGY: options.withStay
				? {
						stay,
						transferToHotel: { mode: 'walk', duration: 30 as Duration, legs: [] },
						transferToConnectionAirport: { mode: 'walk', duration: 30 as Duration, legs: [] }
					}
				: { stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined }
		},
		originLocation: { label: 'Plaça de Catalunya', coordinates: { latitude: 41.387, longitude: 2.17 } },
		transferToOriginAirport: { mode: 'walk', duration: 150 as Duration, legs: [] },
		destinationLocation: { label: 'Bucharest old town', coordinates: { latitude: 44.4323, longitude: 26.103 } },
		transferToDestinationLocation: { mode: 'walk', duration: 200 as Duration, legs: [] },
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	};

	const [itinerary] = buildItineraries(input);
	if (!itinerary) throw new Error('fixture itinerary failed to build');
	return itinerary;
}

/**
 * An overnight connection with a five-hour layover: lands at 22:00, away again at 03:00, so
 * one night in the stopover with two hours of it free after the walk into town and the
 * pre-boarding buffer.
 *
 * This is the shape issue #224 made the default and the shape a slow transit plan can
 * break, and the ten-day stopover above cannot stand in for it: ten days absorb any
 * transfer without noticing, which is exactly why the defect went unseen while only the
 * longest pairing through each city was ever refined.
 *
 * The bed sits 11km out so a two-and-a-half-hour ride to it stays plausible for the
 * distance (#220's own rule), leaving the layover as the only thing it fails.
 */
function shortStopoverItinerary(): Itinerary {
	const origin = airport('BCN', 41.2971, 2.07846);
	const connection = airport('BGY', 45.6689, 9.7);
	const destination = airport('OTP', 44.5718, 26.1033);

	const [itinerary] = buildItineraries({
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [flight(at('2026-10-04T20:00:00'), at('2026-10-04T22:00:00'), 'BCN', 'BGY')],
		onwardOffers: [flight(at('2026-10-05T03:00:00'), at('2026-10-05T05:00:00'), 'BGY', 'OTP')],
		connectionAirports: { BGY: connection },
		connectionResources: {
			BGY: {
				stay: { ...stay, property: { ...stay.property, coordinates: { latitude: 45.7627, longitude: 9.7 } } },
				transferToHotel: { mode: 'walk', duration: 30 as Duration, legs: [] },
				transferToConnectionAirport: { mode: 'walk', duration: 30 as Duration, legs: [] }
			}
		},
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	});
	if (!itinerary) throw new Error('fixture itinerary failed to build');
	return itinerary;
}

function transitTransfer(): Transfer {
	return {
		mode: 'transit',
		duration: 45 as Duration,
		legs: [],
		transitSchedule: {
			intended: at('2026-10-04T05:15:00'),
			following: [],
			plannedFor: { time: at('2026-10-04T06:15:00'), arriveBy: true }
		}
	};
}

interface FakeProviderOptions {
	answer?: (query: TransferSearchQuery) => ProviderResult<Transfer[]>;
}

function fakeTransitProvider(options: FakeProviderOptions = {}) {
	const queries: TransferSearchQuery[] = [];
	const id = 'transitous' as ProviderId;
	const provider: TransferProvider = {
		kind: 'transfer',
		id,
		label: 'Transitous',
		needsKey: false,
		keyFields: [],
		modes: ['transit'],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: '2026-10-01T00:00:00Z' }, requestsUsed: 0 };
		},
		async searchTransfers(query: TransferSearchQuery, _ctx: ProviderContext): Promise<ProviderResult<Transfer[]>> {
			queries.push(query);
			return (
				options.answer?.(query) ?? {
					ok: true,
					data: [transitTransfer()],
					source: { providerId: id, fetchedAt: '2026-10-01T00:00:00Z' },
					requestsUsed: 1
				}
			);
		}
	};
	return { provider, queries };
}

function run(providers: TransferProvider[], overrides: Partial<Parameters<typeof fetchTransitSchedules>[0]> = {}) {
	return fetchTransitSchedules({
		itinerary: tripItinerary(),
		connectionCoordinates: CONNECTION_COORDINATES,
		connectionLandingBuffer: 30 as Duration,
		destinationLandingBuffer: 15 as Duration,
		transferProviders: providers,
		keys: {},
		signal: new AbortController().signal,
		sources: new SourceTracker(),
		record: () => {},
		budget: createUnboundedTransitLookupBudget(),
		...overrides
	});
}

describe('planTransitLegs', () => {
	it('asks a leg that ends at a check-in gate to arrive by the deadline, not to leave now', () => {
		const plans = planTransitLegs({
			itinerary: tripItinerary(),
			connectionCoordinates: CONNECTION_COORDINATES,
			connectionLandingBuffer: 30 as Duration,
			destinationLandingBuffer: 15 as Duration
		});

		const origin = plans.find((plan) => plan.field === 'transferToOriginAirport');
		// 08:15 departure minus the traveller's own two-hour airport buffer. This exact
		// moment is what the issue reported missing: "the 4 October date nor the 06:15
		// deadline reaches the planner".
		expect(origin?.moment).toEqual({ time: at('2026-10-04T06:15:00'), arriveBy: true });
	});

	it('asks a leg that starts at a runway to leave after landing plus the walk out', () => {
		const plans = planTransitLegs({
			itinerary: tripItinerary(),
			connectionCoordinates: CONNECTION_COORDINATES,
			connectionLandingBuffer: 30 as Duration,
			destinationLandingBuffer: 15 as Duration
		});

		const destination = plans.find((plan) => plan.field === 'transferToDestinationLocation');
		// Lands 19:25 at OTP, on the street 15 minutes later.
		expect(destination?.moment).toEqual({ time: at('2026-10-14T19:40:00'), arriveBy: false });
	});

	it('raises no question about a stopover leg when no bed was priced for it', () => {
		const plans = planTransitLegs({
			itinerary: tripItinerary(),
			connectionCoordinates: CONNECTION_COORDINATES,
			connectionLandingBuffer: 30 as Duration,
			destinationLandingBuffer: 15 as Duration
		});
		expect(plans.map((plan) => plan.field)).toEqual(['transferToOriginAirport', 'transferToDestinationLocation']);
	});
});

describe('fetchTransitSchedules', () => {
	it('puts the journey moment on the wire, never the moment the search ran', async () => {
		const { provider, queries } = fakeTransitProvider();
		await run([provider]);

		expect(queries).toHaveLength(2);
		expect(queries[0]).toMatchObject({ departure: at('2026-10-04T06:15:00'), arriveBy: true, modes: ['transit'] });
		expect(queries[1]).toMatchObject({ departure: at('2026-10-14T19:40:00'), arriveBy: false, modes: ['transit'] });
	});

	it('swaps the transit answer into the itinerary and recomputes what it changes', async () => {
		const { provider } = fakeTransitProvider();
		const before = tripItinerary();
		const { itinerary } = await run([provider], { itinerary: before });

		expect(itinerary.transferToOriginAirport?.mode).toBe('transit');
		expect(itinerary.transferToDestinationLocation?.mode).toBe('transit');
		// The door-to-door total moves with the swap rather than being left describing
		// transfers nobody is taking: 150 minutes of walking to BCN becomes a 45-minute bus,
		// and 200 minutes across Bucharest becomes 45 plus the 15-minute walk out of OTP.
		expect(itinerary.times.total).toBe(before.times.total - (150 - 45) - (200 - 60));
	});

	it('records "asked, and there is no service here" apart from "nobody asked"', async () => {
		const { provider } = fakeTransitProvider({
			answer: () => ({
				ok: true,
				data: [],
				source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
				requestsUsed: 1
			})
		});

		const { answers } = await run([provider]);

		// The Bucharest case: HTTP 200, `itineraries: []`, no error. The picker needs to say
		// "no public transport data for this area", not stay silent.
		expect(answers.transferToDestinationLocation?.answer).toBe('nothing-found');
		expect(answers.transferToDestinationLocation?.plannedFor).toEqual({
			time: at('2026-10-14T19:40:00'),
			arriveBy: false
		});
	});

	it('carries a provider failure through with its own message and status', async () => {
		const { provider } = fakeTransitProvider({
			answer: () => ({
				ok: false,
				error: { code: 'quota-exceeded', message: 'Transitous responded 429: slow down', status: 429 },
				source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
				requestsUsed: 1
			})
		});

		const { answers } = await run([provider]);

		expect(answers.transferToOriginAirport?.answer).toBe('failed');
		expect(answers.transferToOriginAirport?.error).toMatchObject({ status: 429, message: 'Transitous responded 429: slow down' });
	});

	it('says no timetable provider was available rather than implying there is no service', async () => {
		const { answers } = await run([]);
		expect(answers.transferToOriginAirport).toEqual({
			answer: 'not-asked',
			reason: 'no-provider',
			plannedFor: { time: at('2026-10-04T06:15:00'), arriveBy: true }
		});
	});

	it('stops at the search ration and says so, instead of quietly asking anyway', async () => {
		const { provider, queries } = fakeTransitProvider();
		const budget = createTransitLookupBudget(1);

		const { answers } = await run([provider], { budget });

		expect(queries).toHaveLength(1);
		expect(answers.transferToDestinationLocation).toMatchObject({ answer: 'not-asked', reason: 'budget-spent' });
		expect(budget.spent()).toBe(1);
	});

	it('asks four questions, not two, once a bed makes the stopover legs real', async () => {
		const { provider, queries } = fakeTransitProvider();
		await run([provider], { itinerary: tripItinerary({ withStay: true }) });

		expect(queries.map((query) => query.arriveBy)).toEqual([true, false, true, false]);
	});

	it('keeps the road leg when a plausible transit plan would still swallow the stopover', async () => {
		// Measured on production for BVC to PFO once issue #224 made the SHORTEST pairing
		// the one refined: the Birmingham card printed "-19h 38m in Birmingham", because
		// `recomputeItinerarySelection` returned an itinerary with an
		// `insufficient-connection-time` warning and this module dropped the warning and
		// kept the itinerary.
		//
		// Distinct from #220's plausibility rule, which refuses a route that is absurd for
		// its distance. A 2h30m ride to a bed 11km out is a perfectly ordinary answer, and
		// it is still more than a five-hour layover can pay for.
		const slowPlan = (): Transfer => ({ ...transitTransfer(), duration: 150 as Duration });
		const { provider } = fakeTransitProvider({
			answer: () => ({
				ok: true,
				data: [slowPlan()],
				source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
				requestsUsed: 1
			})
		});
		const before = shortStopoverItinerary();

		const { itinerary, answers } = await run([provider], { itinerary: before });

		expect(itinerary.freeTime.duration).toBeGreaterThanOrEqual(0);
		expect(itinerary.transferToHotel?.mode).toBe('walk');
		// The timetable still reported what it found. "We asked and this is the journey"
		// stays true whether or not this trip can afford it.
		expect(answers.transferToHotel?.answer).toBe('answered');
	});

	describe('a route refused as implausible (issue #220)', () => {
		/** 21h 27m, the shape Transitous answered the owner's 9.7 km Birmingham hop with. */
		function absurdTransfer(): Transfer {
			return { ...transitTransfer(), duration: 1287 as Duration };
		}

		it('never becomes the itinerary\'s transfer', async () => {
			const { provider } = fakeTransitProvider({
				answer: () => ({
					ok: true,
					data: [absurdTransfer()],
					source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
					requestsUsed: 1
				})
			});

			const before = tripItinerary();
			const { itinerary } = await run([provider], { itinerary: before });

			// Untouched: the 150-minute walk it was built with is still the pick, and the
			// door-to-door figure has not grown by 21 hours of somebody else's flight.
			expect(itinerary.transferToOriginAirport?.mode).toBe('walk');
			expect(itinerary).toBe(before);
		});

		it('says a route came back and was refused, not that there is no service', async () => {
			const { provider } = fakeTransitProvider({
				answer: () => ({
					ok: true,
					data: [absurdTransfer()],
					source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
					requestsUsed: 1
				})
			});

			const { answers } = await run([provider]);
			const leg = answers.transferToOriginAirport;

			// 'nothing-found' would be the lie: Transitous did answer. What the traveller is
			// owed is the observation, with the numbers it was judged on.
			expect(leg?.answer).toBe('answered');
			expect(leg?.withheld?.count).toBe(1);
			expect(leg?.withheld?.quickest).toBe(1287);
			// Plaça de Catalunya to the airport, the leg's own straight line.
			expect(leg?.withheld?.straightLineKm).toBeCloseTo(12.6, 1);
		});

		it('stays quiet when the same leg also found a real bus', async () => {
			const { provider } = fakeTransitProvider({
				answer: () => ({
					ok: true,
					data: [absurdTransfer(), transitTransfer()],
					source: { providerId: 'transitous' as ProviderId, fetchedAt: '2026-10-01T00:00:00Z' },
					requestsUsed: 1
				})
			});

			const { answers, itinerary } = await run([provider]);

			expect(answers.transferToOriginAirport?.withheld).toBeUndefined();
			expect(itinerary.transferToOriginAirport?.mode).toBe('transit');
			expect(itinerary.transferToOriginAirport?.duration).toBe(45);
		});
	});
});
