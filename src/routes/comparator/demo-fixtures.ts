/**
 * Fixture data for `/comparator/?demo=1` (see +page.svelte). Pure and Svelte-free so it
 * can be unit tested the same way the rest of this app's pure logic is, and reused
 * directly by tests/e2e/comparator.spec.ts rather than that spec guessing at selectors
 * against hand-authored HTML.
 *
 * Three itineraries built from the same shape of inputs (one origin, one destination, no
 * origin/destination *location* legs) but different flight carriers, prices, transfer leg
 * counts and stopover lengths — the "different leg counts" the issue's acceptance
 * criterion names, and the case that actually exercises subgrid: unequal row content
 * heights that still have to land on the same row track across every column.
 */

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
} from '$lib/domain';
import { buildItineraries } from '$lib/algorithm/build';
import type { ComparedItinerary } from '$lib/components';
import type { ProviderId } from '$lib/providers/types';

const austria: Country = { isoCode: 'AT', name: 'Austria' };
const vienna: City = {
	name: 'Vienna',
	coordinates: { latitude: 48.2082, longitude: 16.3738 },
	country: austria
};

function airport(iataCode: string, name: string): Airport {
	return {
		iataCode,
		name,
		coordinates: { latitude: 0, longitude: 0 },
		city: vienna,
		country: austria,
		sizeClass: 'medium'
	};
}

function localDateTime(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function flight(
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	durationMinutes: number,
	carrierName: string,
	carrierCode: string,
	priceMinorUnits: number
): FlightOffer {
	return {
		carrier: { iataCode: carrierCode, name: carrierName },
		flightNumber: `${carrierCode}482`,
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		duration: durationMinutes as Duration,
		price: { minorUnits: priceMinorUnits, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function stay(pricePerNightMinorUnits: number, propertyName: string): Stay {
	return {
		property: { name: propertyName, coordinates: { latitude: 0, longitude: 0 }, images: [], rating: 4.2 },
		roomKind: 'dorm',
		pricePerNight: { minorUnits: pricePerNightMinorUnits, currency: 'EUR' }
	};
}

/** `legCount` mirrors `Transfer.legs`: one entry per change, so a transit transfer with
 * two changes renders taller than a one-leg walk, without changing which row it is. */
function transfer(durationMinutes: number, legCount: number): Transfer {
	return {
		mode: legCount > 1 ? 'transit' : 'walk',
		duration: durationMinutes as Duration,
		legs: Array.from({ length: legCount }, (_, i) => ({
			mode: legCount > 1 ? 'transit' : 'walk',
			description: legCount > 1 ? `Tram ${i + 1}` : undefined,
			duration: Math.round(durationMinutes / legCount) as Duration
		}))
	};
}

const origin = airport('LGW', 'London Gatwick');
const destination = airport('IST', 'Istanbul Airport');

interface DemoItineraryOptions {
	id: string;
	connectionCode: string;
	connectionName: string;
	carrierName: string;
	carrierCode: string;
	outboundPriceMinorUnits: number;
	transferLegCount: number;
	/** Days between arrival at the connection and departing onward, driving how long a
	 * stopover this itinerary has — the free-time magnitude the hybrid share bar in
	 * Comparator.svelte compares across columns. */
	stopoverDays: number;
	stayPricePerNight: number;
	propertyName: string;
}

function buildDemoItinerary(options: DemoItineraryOptions): Itinerary {
	const outboundArrival = localDateTime('2026-06-01T14:20:00');
	// A zero-night "day stopover" still needs to depart *later the same day* than the
	// 14:20 arrival above (not at 11:00, which would be a negative layover), so it gets
	// its own later time-of-day rather than reusing the multi-night departure hour.
	const onwardDay = 1 + options.stopoverDays;
	const onwardTime = options.stopoverDays === 0 ? '21:30:00' : '11:00:00';
	const onwardDeparture = localDateTime(`2026-06-0${onwardDay}T${onwardTime}`);

	const [itinerary] = buildItineraries({
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [
			flight(
				'LGW',
				options.connectionCode,
				outboundArrival,
				outboundArrival,
				155,
				options.carrierName,
				options.carrierCode,
				options.outboundPriceMinorUnits
			)
		],
		onwardOffers: [
			flight(options.connectionCode, 'IST', onwardDeparture, onwardDeparture, 105, 'Turkish Airlines', 'TK', 6200)
		],
		connectionAirports: { [options.connectionCode]: airport(options.connectionCode, options.connectionName) },
		connectionResources: {
			[options.connectionCode]: {
				stay: stay(options.stayPricePerNight, options.propertyName),
				transferToHotel: transfer(25, options.transferLegCount),
				transferToConnectionAirport: transfer(25, 1)
			}
		},
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	});
	return itinerary;
}

export function buildDemoComparedItineraries(): ComparedItinerary[] {
	const now = new Date().toISOString();
	const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();

	return [
		{
			id: 'demo-vienna',
			itinerary: buildDemoItinerary({
				id: 'demo-vienna',
				connectionCode: 'VIE',
				connectionName: 'Vienna International',
				carrierName: 'Vueling',
				carrierCode: 'VY',
				outboundPriceMinorUnits: 5400,
				transferLegCount: 1,
				stopoverDays: 3,
				stayPricePerNight: 2800,
				propertyName: 'Wombat’s City Hostel'
			}),
			sources: [
				{ providerId: 'skyscanner', fetchedAt: fiveMinutesAgo },
				// Illustrative only: Hostelworld has no RapidAPI listing (docs/PROVIDERS.md)
				// and is not a registered adapter, so this id is cast rather than added to
				// the real `ProviderId` union (issue #69) — this demo page shows what a
				// third source COULD look like, not a provider this app actually calls.
				{ providerId: 'hostelworld' as ProviderId, fetchedAt: now }
			]
		},
		{
			id: 'demo-budapest',
			itinerary: buildDemoItinerary({
				id: 'demo-budapest',
				connectionCode: 'BUD',
				connectionName: 'Budapest Ferenc Liszt',
				carrierName: 'Wizz Air',
				carrierCode: 'W6',
				outboundPriceMinorUnits: 3900,
				transferLegCount: 3,
				stopoverDays: 1,
				stayPricePerNight: 1900,
				propertyName: 'Maverick Hostel'
			}),
			sources: [{ providerId: 'ryanair', fetchedAt: now }]
		},
		{
			id: 'demo-prague',
			itinerary: buildDemoItinerary({
				id: 'demo-prague',
				connectionCode: 'PRG',
				connectionName: 'Václav Havel Prague',
				carrierName: 'Ryanair',
				carrierCode: 'FR',
				outboundPriceMinorUnits: 4600,
				transferLegCount: 2,
				stopoverDays: 0,
				stayPricePerNight: 2200,
				propertyName: 'Sir Toby’s Hostel'
			})
			// No sources: exercises the "provider data not available yet" fallback.
		}
	];
}
