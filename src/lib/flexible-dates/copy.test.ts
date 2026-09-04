import { describe, expect, it } from 'vitest';
import type { CoverageReport } from './aggregate';
import {
	coverageSentence,
	dayLabel,
	fillCostSentence,
	freshnessSentence,
	monthLabel,
	shortMonthLabel,
	sourcesSentence,
	unknownMonthsSentence
} from './copy';

const NOW = Date.UTC(2026, 8, 4, 12);
const HOUR = 60 * 60_000;

function report(overrides: Partial<CoverageReport> = {}): CoverageReport {
	return {
		pricedTripDays: 0,
		totalDays: 366,
		unknownMonths: [],
		knownMonths: [],
		providerIds: [],
		...overrides
	};
}

describe('labels', () => {
	it('formats months and days the same way in every locale', () => {
		expect(monthLabel('2026-10-01')).toBe('Oct 2026');
		expect(shortMonthLabel('2026-10-01')).toBe('Oct');
		expect(dayLabel('2027-02-03')).toBe('3 Feb 2027');
	});

	it('returns a malformed date unchanged rather than printing NaN', () => {
		expect(monthLabel('nope')).toBe('nope');
		expect(dayLabel('')).toBe('');
	});
});

describe('coverageSentence', () => {
	// A bare "62 days priced" invites the reader to assume the other 304 are expensive.
	it('always states the denominator', () => {
		expect(coverageSentence(report({ pricedTripDays: 62 }))).toBe(
			'62 of 366 days can be priced end to end.'
		);
	});

	it('says nothing is priced rather than showing a zero', () => {
		expect(coverageSentence(report())).toBe('No day in the next 366 has a price on both legs yet.');
	});
});

describe('unknownMonthsSentence', () => {
	it('is absent when every month has something', () => {
		expect(unknownMonthsSentence(report({ knownMonths: ['2026-10-01'] }))).toBeUndefined();
	});

	it('names a single empty month', () => {
		expect(unknownMonthsSentence(report({ unknownMonths: ['2026-11-01'] }))).toBe(
			'Nothing at all for Nov 2026.'
		);
	});

	it('collapses a run of empty months instead of listing thirteen names', () => {
		expect(
			unknownMonthsSentence(
				report({
					unknownMonths: ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']
				})
			)
		).toBe('Nothing at all for Nov 2026 to Feb 2027.');
	});

	it('keeps separate runs separate', () => {
		expect(
			unknownMonthsSentence(report({ unknownMonths: ['2026-11-01', '2026-12-01', '2027-03-01'] }))
		).toBe('Nothing at all for Nov 2026 to Dec 2026 and Mar 2027.');
	});
});

describe('freshnessSentence', () => {
	it('is absent when nothing has been observed', () => {
		expect(freshnessSentence(report(), NOW)).toBeUndefined();
	});

	// The spread is the point: a ranking built from prices two days apart is weaker evidence
	// than one built from prices fetched together.
	it('gives both ends of the spread', () => {
		expect(
			freshnessSentence(
				report({ oldestObservedAt: NOW - 50 * HOUR, newestObservedAt: NOW - HOUR }),
				NOW
			)
		).toBe('Prices fetched between 2 days ago and 1 hour ago.');
	});

	it('collapses to one age when both ends round the same', () => {
		expect(
			freshnessSentence(report({ oldestObservedAt: NOW - HOUR, newestObservedAt: NOW - HOUR }), NOW)
		).toBe('Every price here was fetched 1 hour ago.');
	});
});

describe('sourcesSentence', () => {
	it('names the sources instead of saying "cached data"', () => {
		expect(sourcesSentence(['Ryanair', 'Kiwi.com'])).toBe('Priced by Ryanair and Kiwi.com.');
		expect(sourcesSentence(['Ryanair'])).toBe('Priced by Ryanair.');
		expect(sourcesSentence([])).toBeUndefined();
	});
});

describe('fillCostSentence', () => {
	// The request count has to be visible before the button is pressed, not after.
	it('leads with the request count', () => {
		expect(fillCostSentence(24, 2)).toContain('24 keyless requests');
		expect(fillCostSentence(1, 1)).toContain('1 keyless request');
	});

	it('says there is nothing to do when everything is cached', () => {
		expect(fillCostSentence(0, 2)).toBe('Every month is already cached. Nothing to fetch.');
	});
});
