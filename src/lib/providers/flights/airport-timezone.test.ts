import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../../cache';
import type { ProviderContext } from '../types';
import {
	buildLocalDateTime,
	resolveAirportTimeZone,
	seedTimeZoneForAirport,
	toLocalDateTime,
	utcOffsetMinutesAt
} from './airport-timezone';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function ctx(signal: AbortSignal = new AbortController().signal): ProviderContext {
	return { signal };
}

describe('seedTimeZoneForAirport', () => {
	it('resolves a known airport regardless of case', () => {
		expect(seedTimeZoneForAirport('VIE')).toBe('Europe/Vienna');
		expect(seedTimeZoneForAirport('vie')).toBe('Europe/Vienna');
	});

	it('returns undefined for an airport outside the seed table, without touching the network', () => {
		// A real but obscure regional airport this table does not carry. This is exactly the
		// case resolveAirportTimeZone below must fall through to a live lookup for, and
		// skyscanner-map-offers.ts must be able to drop rather than mis-time if that also
		// comes back empty.
		expect(seedTimeZoneForAirport('XXX')).toBeUndefined();
	});
});

describe('resolveAirportTimeZone', () => {
	it('answers from the seed table with no network call at all', async () => {
		const fetchImpl = vi.fn();
		const result = await resolveAirportTimeZone('VIE', ctx(), { fetchImpl });
		expect(result).toBe('Europe/Vienna');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('falls through to a live Transitous lookup for an airport outside the seed table', async () => {
		// AHO (Alghero, Sardinia): a real, medium-sized regional airport the seed table was
		// never meant to carry (this file's own header: "the busiest routes," not every
		// scheduled airport) — exactly the case issue #75 exists to stop silently dropping.
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse([{ type: 'STOP', name: 'Alghero Airport', lat: 40.632, lon: 8.29, tz: 'Europe/Rome' }])
			);

		const result = await resolveAirportTimeZone('AHO', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result).toBe('Europe/Rome');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('resolves undefined, not a guess, when a non-seeded airport has nothing cached and the live lookup finds nothing', async () => {
		// This is the acceptance-criteria case: a lookup failure with no cache must not
		// produce a mistimed offer. An empty Transitous response (a real, observed case —
		// see this file's own header on airport-timezone.ts and DXB) resolves the same
		// way a network error does: undefined, never a fabricated zone.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

		const result = await resolveAirportTimeZone('AHO', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result).toBeUndefined();
	});

	/**
	 * Confirmed live for issue #124: Transitous's real `/reverse-geocode`, queried for BVC
	 * (Boa Vista) on 2026-09-04, answered 200 with real place data but `"tz":"IANA"` on
	 * every candidate — not an actual zone name. `geocode/transitous-mapper.ts` passes that
	 * string straight through with no validation, and without this guard it reached
	 * `Intl.DateTimeFormat` deep inside `utcOffsetMinutesAt`, which throws `RangeError:
	 * Invalid time zone specified` for anything it does not recognise — uncaught, since
	 * nothing between here and there expects a resolved zone to be unusable. One provider
	 * answering with garbage must degrade to "unresolved", the same as answering with
	 * nothing at all, never crash the caller.
	 */
	it('resolves undefined, not a crash, when the live lookup returns a string Intl cannot use as a zone', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				jsonResponse([{ type: 'STOP', name: 'Aeroporto Internacional Aristides Pereira', lat: 16.1365, lon: -22.8889, tz: 'IANA' }])
			);

		const result = await resolveAirportTimeZone('AHO', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result).toBeUndefined();
	});

	it('resolves undefined, not a guess, when the live lookup itself fails outright', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));

		const result = await resolveAirportTimeZone('AHO', ctx(), {
			fetchImpl,
			resolveStore: async () => new MemoryCacheStore()
		});

		expect(result).toBeUndefined();
	});

	it('reuses a cached live result and does not hit the network a second time', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse([{ type: 'STOP', name: 'Alghero Airport', lat: 40.632, lon: 8.29, tz: 'Europe/Rome' }]));
		const store = new MemoryCacheStore();
		const options = { fetchImpl, resolveStore: async () => store };

		const first = await resolveAirportTimeZone('AHO', ctx(), options);
		const second = await resolveAirportTimeZone('AHO', ctx(), options);

		expect(first).toBe('Europe/Rome');
		expect(second).toBe('Europe/Rome');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe('utcOffsetMinutesAt', () => {
	it('reads the summer (DST) offset for a European zone', () => {
		// Madrid, mid-July: CEST, UTC+2.
		expect(utcOffsetMinutesAt('2026-07-15T10:00:00', 'Europe/Madrid')).toBe(120);
	});

	it('reads the winter (standard time) offset for the same zone', () => {
		// Madrid, mid-January: CET, UTC+1. Same zone, different offset, which is exactly
		// why the offset has to be computed per flight and never cached as a zone constant.
		expect(utcOffsetMinutesAt('2026-01-15T10:00:00', 'Europe/Madrid')).toBe(60);
	});

	it('still reads the DST offset for a flight before the October changeover', () => {
		// The real fixture's flight (2026-10-15) departs before Europe's last-Sunday
		// switch back to standard time (2026-10-25), so Vienna is still CEST, +120. That is
		// the same value skyscanner-map-offers.test.ts expects when it maps that fixture.
		expect(utcOffsetMinutesAt('2026-10-15T08:05:00', 'Europe/Vienna')).toBe(120);
	});

	it('reads standard time once that changeover has passed', () => {
		expect(utcOffsetMinutesAt('2026-11-01T08:05:00', 'Europe/Vienna')).toBe(60);
	});

	it('handles a negative, non-European offset', () => {
		// New York, mid-July: EDT, UTC-4.
		expect(utcOffsetMinutesAt('2026-07-15T10:00:00', 'America/New_York')).toBe(-240);
	});

	it('handles a half-hour offset', () => {
		// India Standard Time is a fixed UTC+5:30, no DST.
		expect(utcOffsetMinutesAt('2026-03-01T10:00:00', 'Asia/Kolkata')).toBe(330);
	});
});

describe('buildLocalDateTime', () => {
	it('attaches the given zone and computed offset to the local string, unchanged', () => {
		expect(buildLocalDateTime('2026-10-15T08:05:00', 'Europe/Madrid')).toEqual({
			local: '2026-10-15T08:05:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});
});

describe('toLocalDateTime', () => {
	it('looks the airport up in the resolved-zones map and attaches the computed offset', () => {
		const timeZones = new Map([['BCN', 'Europe/Madrid']]);
		expect(toLocalDateTime('2026-10-15T08:05:00', 'BCN', timeZones)).toEqual({
			local: '2026-10-15T08:05:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('is case-insensitive on the airport code', () => {
		const timeZones = new Map([['BCN', 'Europe/Madrid']]);
		expect(toLocalDateTime('2026-10-15T08:05:00', 'bcn', timeZones)).toEqual({
			local: '2026-10-15T08:05:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('returns undefined for an airport with no entry in the resolved-zones map, rather than guessing', () => {
		expect(toLocalDateTime('2026-10-15T08:05:00', 'XXX', new Map())).toBeUndefined();
	});
});
