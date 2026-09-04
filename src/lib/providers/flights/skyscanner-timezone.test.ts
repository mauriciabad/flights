import { describe, expect, it } from 'vitest';
import { timeZoneForAirport, toLocalDateTime, utcOffsetMinutesAt } from './skyscanner-timezone';

describe('timeZoneForAirport', () => {
	it('resolves a known airport regardless of case', () => {
		expect(timeZoneForAirport('VIE')).toBe('Europe/Vienna');
		expect(timeZoneForAirport('vie')).toBe('Europe/Vienna');
	});

	it('returns undefined for an airport outside the curated table', () => {
		// A real but obscure regional airport this table does not carry. This is the exact
		// case skyscanner-map-offers.ts must be able to drop rather than mis-time.
		expect(timeZoneForAirport('XXX')).toBeUndefined();
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

describe('toLocalDateTime', () => {
	it('attaches the airport zone and computed offset to the local string, unchanged', () => {
		expect(toLocalDateTime('2026-10-15T08:05:00', 'BCN')).toEqual({
			local: '2026-10-15T08:05:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('returns undefined for an airport this adapter has no zone for, rather than guessing', () => {
		expect(toLocalDateTime('2026-10-15T08:05:00', 'XXX')).toBeUndefined();
	});
});
