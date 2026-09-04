/**
 * Shared minimal fixtures for this directory's own tests, not exercised itself (no
 * `.test.ts` suffix, so vitest.config.ts's `include` pattern skips it), only imported by
 * the tests alongside it. Deliberately smaller than `demo-fixtures.ts`: those fixtures are
 * built to look like a real search for `+page.svelte`'s demo; these just need to be valid
 * enough for `scoreItinerary` to run and for the field this specific test cares about to
 * vary.
 */

import { scoreItinerary } from '$lib/algorithm/score';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Money } from '$lib/domain';
import type { ProviderId } from '$lib/providers/types';
import type { ScoredResult } from './types';

function localDateTime(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function airport(iataCode: string, cityName: string): Airport {
	return {
		iataCode,
		name: `${cityName} Airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city: { name: cityName, coordinates: { latitude: 0, longitude: 0 }, country: { isoCode: 'XX', name: 'Testland' } },
		country: { isoCode: 'XX', name: 'Testland' },
		sizeClass: 'medium'
	};
}

function money(minorUnits: number): Money {
	return { minorUnits, currency: 'EUR' };
}

function flightOffer(
	carrierCode: string,
	from: string,
	to: string,
	priceMinorUnits: number,
	durationMinutes: number
): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: `${carrierCode} Airline` },
		flightNumber: `${carrierCode}100`,
		departureAirport: from,
		arrivalAirport: to,
		departure: localDateTime('2026-10-14T09:00:00'),
		arrival: localDateTime('2026-10-14T11:00:00'),
		duration: durationMinutes as Duration,
		price: money(priceMinorUnits),
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

const CONNECTION = airport('VIE', 'Vienna');

/** A minimal, valid Itinerary. Every field a test cares about is an override; everything
 * else is a plausible constant so the object type-checks without every test re-stating
 * fields that make no difference to the behaviour under test. */
export function makeItinerary(
	overrides: {
		connectionAirportCode?: string;
		outboundCarrier?: string;
		onwardCarrier?: string;
		priceMinorUnits?: number;
		totalMinutes?: number;
		nightsInConnection?: number;
		freeTimeMinutes?: number;
		freeTimeStart?: string;
		freeTimeEnd?: string;
		travellers?: number;
	} = {}
): Itinerary {
	const connectionCode = overrides.connectionAirportCode ?? 'VIE';
	const outboundFlight = flightOffer('VY', 'BCN', connectionCode, 6000, 140);
	const onwardFlight = flightOffer(overrides.onwardCarrier ?? 'W6', connectionCode, 'OTP', 5800, 95);
	if (overrides.outboundCarrier) {
		outboundFlight.carrier = { iataCode: overrides.outboundCarrier, name: `${overrides.outboundCarrier} Airline` };
	}
	const travellers = overrides.travellers ?? 1;
	const nightsInConnection = overrides.nightsInConnection ?? 0;
	// Mirrors `buildItineraries`' own total: both fares scaled to the party by each offer's
	// declared `priceScope`, plus nights x the nightly rate. It used to be the two fares
	// alone, so a fixture with `nightsInConnection: 3` carried a `totalPrice` that its own
	// parts could not add up to — fine while nothing broke a total back down, wrong the
	// moment `priceBreakdown` (itinerary-metrics.ts) did.
	const priceMinorUnits =
		overrides.priceMinorUnits ??
		(outboundFlight.price.minorUnits + onwardFlight.price.minorUnits) * travellers + 2000 * nightsInConnection;
	const totalMinutes = overrides.totalMinutes ?? 600;
	const freeTimeMinutes = overrides.freeTimeMinutes ?? 300;

	return {
		originAirport: airport('BCN', 'Barcelona'),
		originWaitingTime: 120 as Duration,
		outboundFlight,
		transferToHotel: { mode: 'walk', duration: 15 as Duration, legs: [{ mode: 'walk', duration: 15 as Duration }] },
		stay: {
			property: { name: 'Test stay', coordinates: { latitude: 0, longitude: 0 }, images: [] },
			roomKind: 'private',
			pricePerNight: money(2000)
		},
		freeTime: {
			start: localDateTime(overrides.freeTimeStart ?? '2026-10-14T13:00:00'),
			end: localDateTime(overrides.freeTimeEnd ?? '2026-10-14T13:00:00'),
			duration: freeTimeMinutes as Duration
		},
		nightsInConnection,
		transferToConnectionAirport: { mode: 'walk', duration: 15 as Duration, legs: [{ mode: 'walk', duration: 15 as Duration }] },
		connectionWaitingTime: 120 as Duration,
		onwardFlight,
		destinationAirport: airport('OTP', 'Bucharest'),
		totalPrice: money(priceMinorUnits),
		travellers,
		times: {
			inFlight: (outboundFlight.duration + onwardFlight.duration) as Duration,
			airportWaiting: 240 as Duration,
			free: freeTimeMinutes as Duration,
			total: totalMinutes as Duration
		}
	};
}

let idCounter = 0;

/** A minimal, valid ScoredResult, for tests of filtering/sorting/streaming that don't
 * care about the score breakdown's own correctness (score.test.ts already covers that). */
export function makeScoredResult(
	overrides: Parameters<typeof makeItinerary>[0] & { id?: string; sequence?: number; variantCount?: number } = {}
): ScoredResult {
	idCounter += 1;
	const itinerary = makeItinerary(overrides);
	return {
		id: overrides.id ?? `result-${idCounter}`,
		sequence: overrides.sequence ?? idCounter,
		itinerary,
		score: scoreItinerary(itinerary),
		variantCount: overrides.variantCount ?? 1,
		price: {
			parts: [
				{
					part: 'outboundFlight',
					// Fixture-only stand-in id, not a real registered adapter — cast rather
					// than widening ProvenancePart.providerId itself, which is exactly the
					// closed `ProviderId` union issue #69 exists to enforce for real adapters.
					providerId: 'test-provider' as ProviderId,
					providerLabel: 'Test Provider',
					fetchedAt: '2026-10-14T00:00:00.000Z'
				}
			],
			freshness: { tier: 'fresh', ageMs: 0 }
		}
	};
}
