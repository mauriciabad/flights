/**
 * Issue #158: proof, offline, that the currency a search names actually arrives at Agoda as
 * `currency_id`, and that the bed it prices lands in the itinerary total instead of
 * deleting the itinerary.
 *
 * This is the whole chain that was broken, exercised end to end with no network: the real
 * Agoda adapter over its committed fixtures (`fixtures/agoda-search-vienna.json` and
 * `fixtures/agoda-get-prices-wombats-hostel.json`, both captured from real responses on
 * 2026-09-04 by #154's author precisely so nobody has to spend another request), through
 * `fetchConnectionResources`, into `buildItineraries`.
 *
 * The failing half is modelled rather than captured, and here is exactly how. Agoda's
 * documented behaviour, measured live on 2026-09-04 and recorded in `agoda-mapper.ts`, is
 * that USD "never appears in Agoda's own /currencies list and is instead the implicit
 * default when `currency_id` is omitted entirely". The stub below reproduces that rule: a
 * `get-prices` request WITH `currency_id=1` gets the committed EUR fixture back verbatim; a
 * request WITHOUT one gets that same fixture with its currency fields switched to USD. No
 * USD body was ever captured, so this is a stated assumption about the provider, not a
 * recording of it — but it is the assumption the adapter's own comments already document,
 * and it is the only part of this test that is not a real response.
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../cache';
import { buildItineraries } from '../algorithm/build';
import { DEFAULT_SEARCH_CURRENCY } from '../domain';
import type { Airport, Duration, FlightOffer, LocalDateTime } from '../domain';
import { createUnboundedStayLookupBudget } from '../providers/budget';
import type { AvailableKeys, ProviderId, ProviderResult, TransferProvider, TransferSearchQuery } from '../providers/types';
import type { ProviderStatus } from './types';
import { createAgodaStayProvider } from '../providers/stays/agoda';
import agodaGetPricesWombats from '../providers/stays/fixtures/agoda-get-prices-wombats-hostel.json';
import agodaSearchVienna from '../providers/stays/fixtures/agoda-search-vienna.json';
import nominatimVienna from '../providers/stays/fixtures/nominatim-vienna.json';
import { recordProviderResult, SourceTracker } from './provenance';
import { fetchConnectionResources } from './resources';

const VIE_COORDINATES = { latitude: 48.1103, longitude: 16.5697 };

/** The committed EUR fixture with every currency marker switched to USD — Agoda's answer
 * when `currency_id` is absent, per `agoda-mapper.ts`'s recorded measurement. Nothing else
 * about the body changes, which is the point: the prices are identical numbers wearing a
 * different currency, exactly the shape that made a bed look priceable and then poisoned
 * the total. */
const wombatsInUsd = JSON.parse(JSON.stringify(agodaGetPricesWombats).replaceAll('"EUR"', '"USD"'));

function fixtureFetch(): { fetchImpl: typeof fetch; getPricesUrls: string[] } {
	const getPricesUrls: string[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.startsWith('https://nominatim.openstreetmap.org/reverse')) {
			return new Response(JSON.stringify(nominatimVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/overnight-stays/search')) {
			return new Response(JSON.stringify(agodaSearchVienna), { status: 200 });
		}
		if (url.startsWith('https://agoda-com.p.rapidapi.com/hotels-homes/get-prices')) {
			getPricesUrls.push(url);
			const params = new URL(url).searchParams;
			if (params.get('property_id') !== '417108') {
				return new Response(JSON.stringify({ data: { currencyInfo: { code: 'USD' }, roomGridData: { masterRooms: [] } } }), { status: 200 });
			}
			const body = params.has('currency_id') ? agodaGetPricesWombats : wombatsInUsd;
			return new Response(JSON.stringify(body), { status: 200 });
		}
		throw new Error(`no stub for ${url}`);
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, getPricesUrls };
}

/** Transfers are not what this test is about, but `fetchConnectionResources` drops a stay it
 * cannot reach (issue #94), so one that always answers keeps the stay in play. `transit`
 * rather than `taxi` so nothing reaches for OSRM's fare table. */
function alwaysReachableTransferProvider(): TransferProvider {
	const id = 'transit-fixture' as ProviderId;
	const source = { providerId: id, fetchedAt: '2026-09-04T00:00:00Z' };
	return {
		kind: 'transfer',
		id,
		label: 'Fixture transfers',
		modes: ['transit'],
		needsKey: false,
		keyFields: [],
		async healthCheck() {
			return { ok: true, data: {}, source, requestsUsed: 0 };
		},
		async searchTransfers(_query: TransferSearchQuery): Promise<ProviderResult<import('../domain').Transfer[]>> {
			return { ok: true, data: [{ mode: 'transit', duration: 20 as Duration, legs: [] }], source, requestsUsed: 1 };
		}
	};
}

async function resolveStayFor(currency: string | undefined) {
	const { fetchImpl, getPricesUrls } = fixtureFetch();
	const providerStatus = new Map<ProviderId, ProviderStatus>();
	const keys: AvailableKeys = { agoda: { apiKey: 'test-key' } };
	const resources = await fetchConnectionResources({
		connectionCoordinates: VIE_COORDINATES,
		connectionAirportSize: 'large',
		stayProviders: [createAgodaStayProvider({ store: new MemoryCacheStore(), fetchImpl })],
		transferProviders: [alwaysReachableTransferProvider()],
		keys,
		signal: new AbortController().signal,
		stayRadiusKm: 100,
		checkIn: '2026-10-10',
		checkOut: '2026-10-13',
		landingToTransportRules: [],
		stayLookupBudget: createUnboundedStayLookupBudget(),
		sources: new SourceTracker(),
		record: (provider, result) => recordProviderResult(providerStatus, provider as never, result),
		travellers: 1,
		currency
	});
	return { resources, getPricesUrls };
}

// ---------------------------------------------------------------------------
// Flights for the itinerary half, in EUR, three nights apart in Vienna.
// ---------------------------------------------------------------------------

function ldt(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function airport(iataCode: string, city: string, isoCode: string): Airport {
	return {
		iataCode,
		name: `${city} Airport`,
		coordinates: VIE_COORDINATES,
		city: { name: city, coordinates: VIE_COORDINATES, country: { isoCode, name: city } },
		country: { isoCode, name: city },
		sizeClass: 'large'
	};
}

function eurFlight(from: string, to: string, departure: string, arrival: string, minorUnits: number): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber: 'FR1000',
		departureAirport: from,
		arrivalAirport: to,
		departure: ldt(departure),
		arrival: ldt(arrival),
		duration: 150 as Duration,
		price: { minorUnits, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

describe('the search currency reaches Agoda (issue #158)', () => {
	it('puts currency_id on the get-prices request and prices the bed in that currency', async () => {
		const { resources, getPricesUrls } = await resolveStayFor(DEFAULT_SEARCH_CURRENCY);

		expect(getPricesUrls.length).toBeGreaterThan(0);
		for (const url of getPricesUrls) {
			// 1 is Agoda's own numeric id for EUR (`AGODA_CURRENCY_INFO`, captured from its
			// /currencies endpoint). Asserting the parameter on the wire, not the mapper's
			// return value, is the point: the mapper was already right.
			expect(new URL(url).searchParams.get('currency_id')).toBe('1');
		}
		expect(resources.stay?.pricePerNight.currency).toBe('EUR');
	});

	it('omits currency_id when the search names no currency, which is how the bed came back in USD', async () => {
		// The state the app actually shipped in: `SearchDependencies.currency` undefined all
		// the way down. Everything below it worked, and this is what it worked on.
		const { resources, getPricesUrls } = await resolveStayFor(undefined);

		expect(getPricesUrls.length).toBeGreaterThan(0);
		for (const url of getPricesUrls) {
			expect(new URL(url).searchParams.has('currency_id')).toBe(false);
		}
		expect(resources.stay?.pricePerNight.currency).toBe('USD');
	});

	it('assembles a whole itinerary with the bed inside the total', async () => {
		const { resources } = await resolveStayFor(DEFAULT_SEARCH_CURRENCY);
		const stay = resources.stay;
		expect(stay).toBeDefined();
		if (!stay) return;

		const outbound = eurFlight('BCN', 'VIE', '2026-10-10T08:00:00', '2026-10-10T10:30:00', 4500);
		const onward = eurFlight('VIE', 'OTP', '2026-10-13T15:00:00', '2026-10-13T17:30:00', 3500);
		const itineraries = buildItineraries({
			originAirport: airport('BCN', 'Barcelona', 'ES'),
			destinationAirport: airport('OTP', 'Bucharest', 'RO'),
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionAirports: { VIE: airport('VIE', 'Vienna', 'AT') },
			connectionResources: { VIE: resources },
			travellers: 1
		});

		expect(itineraries).toHaveLength(1);
		const itinerary = itineraries[0];
		expect(itinerary.stay?.pricePerNight.currency).toBe('EUR');
		expect(itinerary.nightsInConnection).toBe(3);
		// Flights plus three nights of the bed, to the cent — the assertion that was
		// impossible before, because this candidate did not survive to be built at all.
		expect(itinerary.totalPrice).toEqual({
			minorUnits: 4500 + 3500 + stay.pricePerNight.minorUnits * 3,
			currency: 'EUR'
		});
		expect(itinerary.totalPrice.minorUnits).toBeGreaterThan(8000);
	});

	it('drops only the bed, never the trip, when a provider answers in another currency anyway', async () => {
		// A provider is free to ignore the currency we asked for, so the builder must degrade
		// to a bedless itinerary rather than throw and take the candidate with it (#152's
		// half of this, kept honest here alongside #158's).
		const { resources } = await resolveStayFor(undefined);
		expect(resources.stay?.pricePerNight.currency).toBe('USD');

		const outbound = eurFlight('BCN', 'VIE', '2026-10-10T08:00:00', '2026-10-10T10:30:00', 4500);
		const onward = eurFlight('VIE', 'OTP', '2026-10-13T15:00:00', '2026-10-13T17:30:00', 3500);
		const itineraries = buildItineraries({
			originAirport: airport('BCN', 'Barcelona', 'ES'),
			destinationAirport: airport('OTP', 'Bucharest', 'RO'),
			outboundOffers: [outbound],
			onwardOffers: [onward],
			connectionAirports: { VIE: airport('VIE', 'Vienna', 'AT') },
			connectionResources: { VIE: resources },
			travellers: 1
		});

		expect(itineraries).toHaveLength(1);
		expect(itineraries[0].stay).toBeUndefined();
		expect(itineraries[0].totalPrice).toEqual({ minorUnits: 8000, currency: 'EUR' });
	});
});
