import { describe, expect, it } from 'vitest';
import { describePriceFreshness, describeWhyGood } from './view-model';
import { makeScoredResult } from './test-support';

describe('describeWhyGood', () => {
	it('leads with nights when the itinerary has any, matching the product thesis', () => {
		const result = makeScoredResult({ nightsInConnection: 3 });
		expect(describeWhyGood(result)).toContain('3 nights');
	});

	it('uses singular "night" for exactly one', () => {
		const result = makeScoredResult({ nightsInConnection: 1 });
		expect(describeWhyGood(result)).toContain('1 night ');
	});

	it('falls back to usable free time when there are no nights but a long daytime window', () => {
		const result = makeScoredResult({
			nightsInConnection: 0,
			freeTimeStart: '2026-10-14T10:00:00',
			freeTimeEnd: '2026-10-14T18:00:00'
		});
		expect(describeWhyGood(result)).toMatch(/free in the stopover/);
	});

	it('mentions the avoided airline when that is the only reason it ranks lower', () => {
		const result = makeScoredResult({ outboundCarrier: 'FR', nightsInConnection: 0 });
		// Re-score with FR on the avoid list, the way the real pipeline would.
		const avoided = { ...result, score: { ...result.score, avoidedAirlineFlightCount: 1 } };
		expect(describeWhyGood(avoided)).toMatch(/avoid/);
	});

	it('never invents a number that is not already in the score breakdown', () => {
		const result = makeScoredResult({ nightsInConnection: 2 });
		const text = describeWhyGood(result);
		// The only numbers this function is allowed to state are ones it can point back
		// to a real field on `result`, nights (2) here.
		const numbers = text.match(/\d+/g) ?? [];
		expect(numbers).toEqual(['2']);
	});

	it('leads with a real night count even with no stay priced, per issue #105', () => {
		const result = makeScoredResult({ nightsInConnection: 12 });
		// `makeItinerary` always includes a stay — strip it the same way the "no stay"
		// test below does, to reproduce the exact keyless-search shape from issue #105.
		const withoutStay = {
			...result,
			itinerary: { ...result.itinerary, stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined }
		};

		const text = describeWhyGood(withoutStay);
		expect(text).toContain('12 nights');
		expect(text).toMatch(/no bed priced/i);
		// Never the old all-or-nothing line: a real 12-night stopover is not "no stay
		// priced for this stopover yet — showing flights and free time only."
		expect(text).not.toMatch(/showing flights and free time only/i);
	});

	it('never mentions a missing stay on a same-day connection (issue #140)', () => {
		// Issue #94 put a "No stay priced for this stopover yet" line here, back when a
		// zero night count could be a fabricated zero rather than a real schedule fact.
		// Since #110 nights come straight off the free-time window, so zero means the
		// traveller lands and leaves the same day: nothing is missing, nothing is coming,
		// and "yet" was a promise about a future that does not exist.
		const result = makeScoredResult({
			nightsInConnection: 0,
			freeTimeStart: '2026-10-14T14:35:00',
			freeTimeEnd: '2026-10-14T16:15:00'
		});
		// `makeItinerary` (test-support.ts) always includes a stay — this is the one case
		// `fetchConnectionResources` produces with none, degraded here rather than adding a
		// second fixture builder for one field.
		const withoutStay = {
			...result,
			itinerary: { ...result.itinerary, stay: undefined, transferToHotel: undefined, transferToConnectionAirport: undefined }
		};

		const text = describeWhyGood(withoutStay);
		expect(text).not.toMatch(/stay priced/i);
		expect(text).not.toMatch(/bed priced/i);
		expect(text).not.toMatch(/yet/i);
	});
});

describe('describePriceFreshness', () => {
	it('renders fresh as plain and unflagged', () => {
		const display = describePriceFreshness({ tier: 'fresh' });
		expect(display.tone).toBe('neutral');
	});

	it('renders stale distinctly, as a search still in progress rather than a finished number', () => {
		const display = describePriceFreshness({ tier: 'stale' });
		expect(display.tone).toBe('info');
		expect(display.label).toMatch(/confirming/i);
	});

	it('renders expired-fallback with its age and the real reason, never as current', () => {
		const display = describePriceFreshness({
			tier: 'expired-fallback',
			ageMs: 2 * 24 * 60 * 60 * 1000,
			reason: 'quota-exceeded',
			message: 'Quota used up for now.'
		});
		expect(display.tone).toBe('warning');
		expect(display.label).toContain('days ago');
		expect(display.label).toContain('Quota used up for now.');
	});
});
