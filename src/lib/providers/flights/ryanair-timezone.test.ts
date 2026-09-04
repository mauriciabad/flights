import { describe, expect, it } from 'vitest';
import { computeFlightDuration, computeUtcOffsetMinutes, toLocalDateTime } from './ryanair-timezone';

describe('computeUtcOffsetMinutes', () => {
	it('resolves Madrid to +120 in October, before the DST change', () => {
		// 2026-10-25 is the last Sunday of October — CEST (+2) is still in effect on the
		// 13th. Cross-checked independently with `Intl.DateTimeFormat` against the raw UTC
		// instant while building this fixture.
		expect(computeUtcOffsetMinutes('2026-10-13T09:10:00', 'Europe/Madrid')).toBe(120);
	});

	it('resolves London to +60 (BST) on the same date', () => {
		expect(computeUtcOffsetMinutes('2026-10-13T10:35:00', 'Europe/London')).toBe(60);
	});

	it('resolves both zones to standard time once DST has ended', () => {
		expect(computeUtcOffsetMinutes('2026-11-01T09:00:00', 'Europe/Madrid')).toBe(60);
		expect(computeUtcOffsetMinutes('2026-11-01T09:00:00', 'Europe/London')).toBe(0);
	});
});

describe('toLocalDateTime', () => {
	it('carries the local string and zone through unchanged, adding only the offset', () => {
		expect(toLocalDateTime('2026-10-13T09:10:00', 'Europe/Madrid')).toEqual({
			local: '2026-10-13T09:10:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});
});

describe('computeFlightDuration', () => {
	it('gets a same-offset flight right with plain subtraction', () => {
		const departure = toLocalDateTime('2026-10-16T05:45:00', 'Europe/Madrid');
		const arrival = toLocalDateTime('2026-10-16T07:10:00', 'Europe/Rome'); // also +120 that day
		expect(computeFlightDuration(departure, arrival)).toBe(85);
	});

	it('accounts for the departure and arrival airports being at different offsets', () => {
		// BCN 09:10 (+120) -> STN 10:35 (+60): 07:10 UTC -> 09:35 UTC = 145 minutes, not the
		// 85 a naive same-zone subtraction of the local clock times would give.
		const departure = toLocalDateTime('2026-10-13T09:10:00', 'Europe/Madrid');
		const arrival = toLocalDateTime('2026-10-13T10:35:00', 'Europe/London');
		expect(computeFlightDuration(departure, arrival)).toBe(145);
	});

	it('does not lose a night on an overnight arrival', () => {
		// A flight landing just after midnight local: the naive wall-clock difference
		// would look negative if anyone forgot the date rolled over. LocalDateTime.local
		// always carries its own date, so this needs no special-casing here — this test
		// exists to prove that, not to add any.
		const departure = toLocalDateTime('2026-10-16T23:30:00', 'Europe/Madrid');
		const arrival = toLocalDateTime('2026-10-17T00:55:00', 'Europe/Madrid');
		expect(computeFlightDuration(departure, arrival)).toBe(85);
	});
});
