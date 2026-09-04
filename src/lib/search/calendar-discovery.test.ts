import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAirportInfo } from '../algorithm/connections';
import type { FlightOffer } from '../domain';
import type { AvailableKeys, FlightSearchQuery, ProviderContext, ProviderId, ProviderResult } from '../providers/types';
import {
	CALENDAR_DISCOVERY_HUB_POOL,
	MAX_CALENDAR_DISCOVERY_HUBS,
	calendarConfirmedOffers,
	discoverCandidateViaCalendar,
	pickCalendarDateInWindow
} from './calendar-discovery';
import type { FlightsSkyProvider, PriceCalendarDay, PriceCalendarQuery } from './price-calendar';
import { SourceTracker } from './provenance';
import type { RecordProviderCall } from './provenance';

const ORIGIN = 'ZOR';
const DEST = 'ZDE';

function day(date: string, group: PriceCalendarDay['group'], minorUnits: number): PriceCalendarDay {
	return { date, group, price: { minorUnits, currency: 'EUR' } };
}

function offer(origin: string, destination: string): FlightOffer {
	return {
		carrier: { iataCode: 'FA', name: 'Fixture Air' },
		flightNumber: 'FA1',
		departureAirport: origin,
		arrivalAirport: destination,
		departure: { local: '2026-10-01T08:00:00', timeZone: 'UTC', utcOffsetMinutes: 0 },
		arrival: { local: '2026-10-01T10:00:00', timeZone: 'UTC', utcOffsetMinutes: 0 },
		duration: 120,
		price: { minorUnits: 9700, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 0, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	} as FlightOffer;
}

function noopRecord(): RecordProviderCall {
	return vi.fn();
}

/** A `FlightsSkyProvider`-shaped fixture with fully configurable calendar/search behaviour,
 * so each test controls exactly which (origin, destination) pairs "exist" without
 * duplicating a bespoke provider object per test. */
function fixtureCalendarProvider(options: {
	id?: ProviderId;
	needsKey?: boolean;
	calendarCostPerCall?: number;
	searchCostPerCall?: number;
	/** Pairs the calendar has any price for at all. */
	calendarKnows?: (origin: string, destination: string) => boolean;
	/** Pairs `searchOffers` can map into a real, bookable direct offer. Defaults to the same
	 * set as `calendarKnows` when omitted. */
	searchKnows?: (origin: string, destination: string) => boolean;
	calendarDay?: (query: PriceCalendarQuery) => PriceCalendarDay;
	searchFails?: boolean;
}): FlightsSkyProvider & { getPriceCalendarSpy: ReturnType<typeof vi.fn>; searchOffersSpy: ReturnType<typeof vi.fn> } {
	const id = options.id ?? ('flights-sky' as ProviderId);
	const needsKey = options.needsKey ?? true;
	const calendarKnows = options.calendarKnows ?? (() => true);
	const searchKnows = options.searchKnows ?? calendarKnows;
	const mkDay = options.calendarDay ?? ((query: PriceCalendarQuery) => day(query.departDate, 'low', 9700));

	const getPriceCalendarSpy = vi.fn(async (query: PriceCalendarQuery, ctx: ProviderContext): Promise<ProviderResult<PriceCalendarDay[]>> => {
		if (ctx.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: 0 };
		}
		const data = calendarKnows(query.origin, query.destination) ? [mkDay(query)] : [];
		return { ok: true, data, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: options.calendarCostPerCall ?? 1 };
	});

	const searchOffersSpy = vi.fn(async (query: FlightSearchQuery, ctx: ProviderContext): Promise<ProviderResult<FlightOffer[]>> => {
		if (ctx.signal.aborted) {
			return { ok: false, error: { code: 'cancelled', message: 'aborted' }, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: 0 };
		}
		if (options.searchFails) {
			return { ok: false, error: { code: 'network-error', message: 'fixture failure' }, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: 1 };
		}
		const data = searchKnows(query.origin, query.destination) ? [offer(query.origin, query.destination)] : [];
		return { ok: true, data, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: options.searchCostPerCall ?? 1 };
	});

	return {
		kind: 'flight',
		id,
		label: 'Fixture Flights Sky',
		needsKey,
		keyFields: needsKey ? [{ id: 'apiKey', label: 'API key' }] : [],
		async healthCheck() {
			return { ok: true, data: {}, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: 0 };
		},
		estimateSearchOffersCost: () => options.searchCostPerCall ?? 1,
		searchOffers: searchOffersSpy,
		async listDirectDestinations() {
			return { ok: false, error: { code: 'unknown', message: 'no route-graph endpoint' }, source: { providerId: id, fetchedAt: 'now' }, requestsUsed: 0 };
		},
		estimatePriceCalendarCost: () => options.calendarCostPerCall ?? 1,
		getPriceCalendar: getPriceCalendarSpy,
		getPriceCalendarSpy,
		searchOffersSpy
	};
}

describe('pickCalendarDateInWindow', () => {
	it('returns undefined when no day falls inside the window', () => {
		const days = [day('2026-11-01', 'low', 3000)];
		expect(pickCalendarDateInWindow(days, '2026-10-01', '2026-10-10')).toBeUndefined();
	});

	it('prefers a "low"-banded day over a cheaper day outside that band', () => {
		const days = [day('2026-10-02', 'low', 5000), day('2026-10-03', 'medium', 2000)];
		expect(pickCalendarDateInWindow(days, '2026-10-01', '2026-10-10')).toBe('2026-10-02');
	});

	it('falls back to the cheapest day in range when nothing is banded "low"', () => {
		const days = [day('2026-10-02', 'high', 5000), day('2026-10-03', 'medium', 2000)];
		expect(pickCalendarDateInWindow(days, '2026-10-01', '2026-10-10')).toBe('2026-10-03');
	});

	it('ignores days outside the window even when they are cheaper', () => {
		const days = [day('2026-09-01', 'low', 10), day('2026-10-05', 'low', 5000)];
		expect(pickCalendarDateInWindow(days, '2026-10-01', '2026-10-10')).toBe('2026-10-05');
	});
});

describe('calendarConfirmedOffers', () => {
	const keys: AvailableKeys = { 'flights-sky': { apiKey: 'k' } };
	const signal = new AbortController().signal;

	it('confirms a real offer for a narrowed single date when both the calendar and the confirm call succeed', async () => {
		const provider = fixtureCalendarProvider({});
		const sources = new SourceTracker();
		const record = noopRecord();

		const offers = await calendarConfirmedOffers(provider, ORIGIN, DEST, '2026-10-01', '2026-10-10', {}, keys, signal, sources, record);

		expect(offers).toHaveLength(1);
		expect(sources.sourceFor(offers[0])?.providerId).toBe('flights-sky');
		// Narrowed to exactly one date: the confirm call's own query must not span the
		// original window, or its cost would stop being quota-generous.
		const confirmCall = provider.searchOffersSpy.mock.calls[0][0] as FlightSearchQuery;
		expect(confirmCall.earliestDeparture).toBe(confirmCall.latestDeparture);
	});

	it('returns nothing, and never calls searchOffers, when the calendar has no day in the window', async () => {
		const provider = fixtureCalendarProvider({ calendarKnows: () => false });
		const sources = new SourceTracker();
		const record = noopRecord();

		const offers = await calendarConfirmedOffers(provider, ORIGIN, DEST, '2026-10-01', '2026-10-10', {}, keys, signal, sources, record);

		expect(offers).toEqual([]);
		expect(provider.searchOffersSpy).not.toHaveBeenCalled();
	});

	it('returns nothing when the confirm call fails even though the calendar succeeded', async () => {
		const provider = fixtureCalendarProvider({ searchFails: true });
		const sources = new SourceTracker();
		const record = noopRecord();

		const offers = await calendarConfirmedOffers(provider, ORIGIN, DEST, '2026-10-01', '2026-10-10', {}, keys, signal, sources, record);

		expect(offers).toEqual([]);
	});

	it('never calls the calendar at all when its own cost is not quota-generous for this provider', async () => {
		// A calendar call this expensive against Flights Sky's real 40-request cap
		// (40 / 21 < 20) fails `isQuotaGenerous` — this module must not spend it.
		const provider = fixtureCalendarProvider({ calendarCostPerCall: 21 });
		const sources = new SourceTracker();
		const record = noopRecord();

		const offers = await calendarConfirmedOffers(provider, ORIGIN, DEST, '2026-10-01', '2026-10-10', {}, keys, signal, sources, record);

		expect(offers).toEqual([]);
		expect(provider.getPriceCalendarSpy).not.toHaveBeenCalled();
	});
});

describe('discoverCandidateViaCalendar', () => {
	const keys: AvailableKeys = { 'flights-sky': { apiKey: 'k' } };
	const signal = new AbortController().signal;
	const window = { earliestDeparture: '2026-10-01', latestDeparture: '2026-10-10' };
	const alwaysKnown: ConnectionAirportInfo = { coordinates: { latitude: 0, longitude: 0 }, sizeClass: 'large', countryCode: 'XX' };

	function baseInput(overrides: Partial<Parameters<typeof discoverCandidateViaCalendar>[0]> = {}) {
		return {
			originAirport: ORIGIN,
			destinationAirport: DEST,
			outboundWindow: window,
			onwardWindow: window,
			resolveAirportInfo: async () => alwaysKnown,
			flightProviders: [],
			keys,
			signal,
			currency: 'EUR' as const,
			sources: new SourceTracker(),
			record: noopRecord(),
			...overrides
		};
	}

	it('returns undefined when no calendar-capable provider is usable (no key configured)', async () => {
		const provider = fixtureCalendarProvider({});
		const result = await discoverCandidateViaCalendar(baseInput({ flightProviders: [provider], keys: {} }));

		expect(result).toBeUndefined();
		expect(provider.getPriceCalendarSpy).not.toHaveBeenCalled();
	});

	it('returns undefined when the origin-to-destination baseline has no calendar data at all', async () => {
		// Knows nothing for ORIGIN -> DEST directly, and (deliberately) nothing for any hub
		// either — this test is specifically about the baseline gate short-circuiting before
		// any hub is ever probed.
		const provider = fixtureCalendarProvider({ calendarKnows: () => false });
		const result = await discoverCandidateViaCalendar(baseInput({ flightProviders: [provider] }));

		expect(result).toBeUndefined();
		// Exactly one call: the baseline check. No hub was probed.
		expect(provider.getPriceCalendarSpy).toHaveBeenCalledTimes(1);
		expect(provider.getPriceCalendarSpy).toHaveBeenCalledWith(
			expect.objectContaining({ origin: ORIGIN, destination: DEST }),
			expect.anything()
		);
	});

	it('finds the first bundled hub that clears both legs once the baseline confirms the pair is priceable', async () => {
		const hub = CALENDAR_DISCOVERY_HUB_POOL[0];
		const provider = fixtureCalendarProvider({
			calendarKnows: (o, d) => (o === ORIGIN && d === DEST) || (o === ORIGIN && d === hub) || (o === hub && d === DEST)
		});

		const result = await discoverCandidateViaCalendar(baseInput({ flightProviders: [provider] }));

		expect(result?.candidate.airportCode).toBe(hub);
		expect(result?.candidate.confirmedBy).toEqual({ outbound: 'flights-sky', inbound: 'flights-sky' });
		expect(result?.outboundOffers).toHaveLength(1);
		expect(result?.onwardOffers).toHaveLength(1);
	});

	it('skips the baseline check and probes exactly the given airports when an explicit allow-list is supplied', async () => {
		const allowed = 'ZFA';
		// The baseline (ORIGIN -> DEST) knows nothing, which would normally short-circuit —
		// but an explicit allow-list is itself the consent, same as this issue's own
		// "pasting a key is the consent" reasoning for a provider.
		const provider = fixtureCalendarProvider({
			calendarKnows: (o, d) => (o === ORIGIN && d === allowed) || (o === allowed && d === DEST)
		});

		const result = await discoverCandidateViaCalendar(
			baseInput({ flightProviders: [provider], allowedConnectionAirports: [allowed] })
		);

		expect(result?.candidate.airportCode).toBe(allowed);
		// Every calendar call was for the allow-listed airport, never the baseline pair.
		for (const call of provider.getPriceCalendarSpy.mock.calls) {
			const query = call[0] as PriceCalendarQuery;
			expect(query.origin === ORIGIN ? query.destination : query.origin).toBe(allowed);
		}
	});

	it('never suggests a forbidden airport or a hub in a forbidden country', async () => {
		const hub = CALENDAR_DISCOVERY_HUB_POOL[0];
		const secondHub = CALENDAR_DISCOVERY_HUB_POOL[1];
		const provider = fixtureCalendarProvider({
			calendarKnows: (o, d) =>
				(o === ORIGIN && d === DEST) ||
				(o === ORIGIN && (d === hub || d === secondHub)) ||
				((o === hub || o === secondHub) && d === DEST)
		});

		const result = await discoverCandidateViaCalendar(
			baseInput({
				flightProviders: [provider],
				forbiddenConnectionAirports: [hub],
				forbiddenConnectionCountries: ['ZZ'],
				resolveAirportInfo: async (code) => (code === secondHub ? { ...alwaysKnown, countryCode: 'ZZ' } : alwaysKnown)
			})
		);

		// The first hub is forbidden outright, the second resolves into a forbidden country,
		// and nothing else in the pool has any calendar data at all — nothing survives.
		expect(result).toBeUndefined();
	});

	it('never probes more than MAX_CALENDAR_DISCOVERY_HUBS airports', async () => {
		const explicitPool = Array.from({ length: MAX_CALENDAR_DISCOVERY_HUBS + 4 }, (_, i) => `H${i}`);
		const provider = fixtureCalendarProvider({ calendarKnows: () => false }); // nothing ever works
		const getPriceCalendarSpy = provider.getPriceCalendarSpy;

		await discoverCandidateViaCalendar(
			baseInput({ flightProviders: [provider], allowedConnectionAirports: explicitPool })
		);

		// One calendar call (the outbound leg) per probed hub, capped at the module's own
		// hub limit — never one per entry in an oversized explicit list.
		expect(getPriceCalendarSpy.mock.calls.length).toBeLessThanOrEqual(MAX_CALENDAR_DISCOVERY_HUBS);
	});
});
