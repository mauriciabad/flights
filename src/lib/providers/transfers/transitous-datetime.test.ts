import { describe, expect, it } from 'vitest';
import type { LocalDateTime } from '../../domain';
import { localDateTimeToUtcInstant, utcInstantToLocalDateTime } from './transitous-datetime';

describe('utcInstantToLocalDateTime', () => {
	it('reads the wall clock at the given IANA zone, not UTC', () => {
		// Real Transitous value (2026-09-10 plan response, Barcelona): CEST is UTC+2 in
		// September, so 09:02 UTC reads as 11:02 on a Madrid clock.
		const local = utcInstantToLocalDateTime('2026-09-10T09:02:00Z', 'Europe/Madrid');
		expect(local).toEqual({
			local: '2026-09-10T11:02:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('keeps an overnight instant on the correct local day, not the UTC day', () => {
		// AGENTS.md: "a 00:30 local arrival is still 'today' on the airport clock but
		// already 'tomorrow' in UTC" — this is that case from the other direction: an
		// instant that is still one UTC day, but already past midnight locally.
		const local = utcInstantToLocalDateTime('2026-09-09T22:30:00Z', 'Europe/Madrid');
		expect(local.local).toBe('2026-09-10T00:30:00');
	});

	it('falls back to UTC (zero offset) when no timezone is given', () => {
		const local = utcInstantToLocalDateTime('2026-09-10T09:02:00Z', 'UTC');
		expect(local).toEqual({ local: '2026-09-10T09:02:00', timeZone: 'UTC', utcOffsetMinutes: 0 });
	});

	it('handles a negative offset (west of Greenwich)', () => {
		const local = utcInstantToLocalDateTime('2026-09-10T14:00:00Z', 'America/New_York');
		// EDT (daylight saving) in September: UTC-4.
		expect(local).toEqual({
			local: '2026-09-10T10:00:00',
			timeZone: 'America/New_York',
			utcOffsetMinutes: -240
		});
	});
});

describe('localDateTimeToUtcInstant', () => {
	it('is the inverse of utcInstantToLocalDateTime', () => {
		const original = '2026-09-10T09:02:00.000Z';
		const local = utcInstantToLocalDateTime(original, 'Europe/Madrid');
		expect(localDateTimeToUtcInstant(local).toISOString()).toBe(original);
	});

	it('subtracts a positive offset to recover the earlier UTC instant', () => {
		const local: LocalDateTime = {
			local: '2026-09-10T11:02:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		};
		expect(localDateTimeToUtcInstant(local).toISOString()).toBe('2026-09-10T09:02:00.000Z');
	});
});
