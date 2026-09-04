import { describe, expect, it } from 'vitest';
import { timeZoneForAirport, toLocalDateTime, utcOffsetMinutesAt } from './flights-sky-timezone';

describe('timeZoneForAirport', () => {
	it('resolves a known airport regardless of case', () => {
		expect(timeZoneForAirport('VIE')).toBe('Europe/Vienna');
		expect(timeZoneForAirport('vie')).toBe('Europe/Vienna');
	});

	it('returns undefined for an airport outside the curated table', () => {
		expect(timeZoneForAirport('XXX')).toBeUndefined();
	});
});

describe('utcOffsetMinutesAt', () => {
	it('reads the summer (DST) offset for a European zone', () => {
		expect(utcOffsetMinutesAt('2026-07-15T10:00:00', 'Europe/Madrid')).toBe(120);
	});

	it('reads the winter (standard time) offset for the same zone', () => {
		expect(utcOffsetMinutesAt('2026-01-15T10:00:00', 'Europe/Madrid')).toBe(60);
	});

	it('reads the DST offset for the real fixture flight (2026-09-19, before the October changeover)', () => {
		// fixtures/flights-sky-search-one-way-bcn-vie.json's flight departs/arrives on this
		// date, so this is the exact offset flights-sky-map-offers.test.ts expects.
		expect(utcOffsetMinutesAt('2026-09-19T08:10:00', 'Europe/Vienna')).toBe(120);
	});

	it('reads standard time once that changeover has passed', () => {
		expect(utcOffsetMinutesAt('2026-11-01T08:05:00', 'Europe/Vienna')).toBe(60);
	});

	it('handles a negative, non-European offset', () => {
		expect(utcOffsetMinutesAt('2026-07-15T10:00:00', 'America/New_York')).toBe(-240);
	});

	it('handles a half-hour offset', () => {
		expect(utcOffsetMinutesAt('2026-03-01T10:00:00', 'Asia/Kolkata')).toBe(330);
	});
});

describe('toLocalDateTime', () => {
	it('attaches the airport zone and computed offset to the local string, unchanged', () => {
		expect(toLocalDateTime('2026-09-19T08:10:00', 'BCN')).toEqual({
			local: '2026-09-19T08:10:00',
			timeZone: 'Europe/Madrid',
			utcOffsetMinutes: 120
		});
	});

	it('returns undefined for an airport this adapter has no zone for, rather than guessing', () => {
		expect(toLocalDateTime('2026-09-19T08:10:00', 'XXX')).toBeUndefined();
	});
});
