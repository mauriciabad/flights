import { describe, expect, it } from 'vitest';
import { computeFlightDuration, toLocalDateTime } from './kiwi-timezone';

describe('toLocalDateTime', () => {
	it('derives +120 for a known single-zone country (Spain) in October, before the DST change', () => {
		// 2026-10-13T09:10:00 local Madrid, encoded as Kiwi's fake-UTC/true-UTC pair:
		// fake = the wall clock as if UTC, true = the real instant two hours earlier.
		const fakeUtcSeconds = Date.parse('2026-10-13T09:10:00Z') / 1000;
		const trueUtcSeconds = fakeUtcSeconds - 120 * 60;
		expect(toLocalDateTime(fakeUtcSeconds, trueUtcSeconds, 'ES')).toEqual({
			local: '2026-10-13T09:10:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('derives the offset correctly even without a country match, falling back to a fixed-offset zone', () => {
		const fakeUtcSeconds = Date.parse('2026-10-13T09:10:00Z') / 1000;
		const trueUtcSeconds = fakeUtcSeconds - 180 * 60; // +180 = UTC+3
		const result = toLocalDateTime(fakeUtcSeconds, trueUtcSeconds, undefined);
		expect(result.local).toBe('2026-10-13T09:10:00');
		expect(result.utcOffsetMinutes).toBe(180);
		// Etc/GMT uses the POSIX sign convention: Etc/GMT-3 is UTC+3, not UTC-3.
		expect(result.timeZone).toBe('Etc/GMT-3');
	});

	it('falls back to a negative fixed-offset zone for a western offset with no country match', () => {
		const fakeUtcSeconds = Date.parse('2026-10-13T09:10:00Z') / 1000;
		const trueUtcSeconds = fakeUtcSeconds + 300 * 60; // -300 = UTC-5
		const result = toLocalDateTime(fakeUtcSeconds, trueUtcSeconds, 'ZZ');
		expect(result.utcOffsetMinutes).toBe(-300);
		expect(result.timeZone).toBe('Etc/GMT+5');
	});

	it('is case-insensitive on the country code', () => {
		const fakeUtcSeconds = Date.parse('2026-10-13T09:10:00Z') / 1000;
		const trueUtcSeconds = fakeUtcSeconds - 120 * 60;
		expect(toLocalDateTime(fakeUtcSeconds, trueUtcSeconds, 'es').timeZone).toBe('Europe/Madrid');
	});
});

describe('computeFlightDuration', () => {
	it('gets a same-offset flight right with plain subtraction of the true-UTC pair', () => {
		const departureUtc = Date.parse('2026-10-16T03:45:00Z') / 1000; // 05:45 Madrid local (+120)
		const arrivalUtc = Date.parse('2026-10-16T05:10:00Z') / 1000; // 07:10 Rome local (+120)
		expect(computeFlightDuration(departureUtc, arrivalUtc)).toBe(85);
	});

	it('accounts for departure and arrival airports being at different offsets', () => {
		// BCN 09:10 (+120) -> LHR 10:35 (+60): 07:10 UTC -> 09:35 UTC = 145 minutes, not the
		// 85 a naive same-zone subtraction of the local clock times would give.
		const departureUtc = Date.parse('2026-10-13T07:10:00Z') / 1000;
		const arrivalUtc = Date.parse('2026-10-13T09:35:00Z') / 1000;
		expect(computeFlightDuration(departureUtc, arrivalUtc)).toBe(145);
	});

	it('spans a multi-day self-transfer connection correctly, without conflating it into a flight duration', () => {
		// This is what a single leg's OWN duration looks like even when it happens to be
		// the second half of a several-day self-transfer combo — the gap between the two
		// flights never enters this calculation at all, which is the point: connection
		// time belongs to the itinerary builder (src/lib/domain/itinerary.ts), not to
		// either FlightOffer's `duration`.
		const departureUtc = Date.parse('2026-10-16T12:05:00Z') / 1000;
		const arrivalUtc = Date.parse('2026-10-16T13:55:00Z') / 1000;
		expect(computeFlightDuration(departureUtc, arrivalUtc)).toBe(110);
	});
});
