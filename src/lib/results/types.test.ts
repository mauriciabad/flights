import { describe, expect, it } from 'vitest';
import { scoreItinerary } from '$lib/algorithm/score';
import type { ItineraryGroup, ItineraryResult, PriceCalendarOutcome, ProviderStatus, WidenOption } from '$lib/search';
import { describeProviderError, deriveScoredResult, summarizePriceCalendarOutcome, widenOptionKey } from './types';
import { makeItinerary } from './test-support';

function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
	return {
		providerId: 'ryanair',
		kind: 'flight',
		label: 'Ryanair',
		requestsUsed: 1,
		...overrides
	};
}

// A fetch timestamp is when a real network call actually happened, which is always
// close to "now" (whenever the test runs), never the fictional flight date the itinerary
// itself describes. A fixed past offset keeps `ageMs` meaningfully positive regardless of
// when this test suite runs.
const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000).toISOString();

function group(overrides: { connectionAirportCode?: string; variantCount?: number } = {}): ItineraryGroup {
	const itinerary = makeItinerary({ connectionAirportCode: overrides.connectionAirportCode ?? 'VIE' });
	const result: ItineraryResult = {
		score: scoreItinerary(itinerary),
		sources: {
			outboundFlight: { providerId: 'ryanair', fetchedAt: ONE_HOUR_AGO },
			onwardFlight: { providerId: 'flights-sky', fetchedAt: FIVE_MINUTES_AGO }
		}
	};
	const variants = Array.from({ length: overrides.variantCount ?? 1 }, () => result);
	return { connectionAirportCode: overrides.connectionAirportCode ?? 'VIE', best: result, variants };
}

describe('deriveScoredResult', () => {
	it('carries the group id, itinerary and score straight through', () => {
		const g = group({ connectionAirportCode: 'PRG' });
		const result = deriveScoredResult(g, { providers: {}, done: true }, 7);

		expect(result.id).toBe('PRG');
		expect(result.sequence).toBe(7);
		expect(result.itinerary).toBe(g.best.score.itinerary);
		expect(result.score).toBe(g.best.score);
	});

	it('exposes variantCount from the group', () => {
		const g = group({ variantCount: 3 });
		const result = deriveScoredResult(g, { providers: {}, done: true }, 1);
		expect(result.variantCount).toBe(3);
	});

	it('lists one provenance part per present ItinerarySources field', () => {
		const g = group();
		const result = deriveScoredResult(g, { providers: {}, done: true }, 1);
		const parts = result.price.parts.map((p) => p.part);
		expect(parts).toEqual(['outboundFlight', 'onwardFlight']);
	});

	it('resolves each part label from providers, falling back to the raw id when absent', () => {
		const g = group();
		const result = deriveScoredResult(
			g,
			{ providers: { ryanair: providerStatus({ label: 'Ryanair (keyless)' }) }, done: true },
			1
		);
		const byPart = Object.fromEntries(result.price.parts.map((p) => [p.part, p.providerLabel]));
		expect(byPart.outboundFlight).toBe('Ryanair (keyless)');
		// flights-sky has no entry in `providers` here, so the raw id is the fallback.
		expect(byPart.onwardFlight).toBe('flights-sky');
	});

	it('is fresh once the search is done and no contributing provider has a current error', () => {
		const g = group();
		const result = deriveScoredResult(g, { providers: {}, done: true }, 1);
		expect(result.price.freshness).toEqual({ tier: 'fresh' });
	});

	it('is stale while the search is still running, even with no error', () => {
		const g = group();
		const result = deriveScoredResult(g, { providers: {}, done: false }, 1);
		expect(result.price.freshness).toEqual({ tier: 'stale' });
	});

	it('is expired-fallback when a contributing provider has a current error, regardless of done', () => {
		const g = group();
		const providers: Record<string, ProviderStatus> = {
			'flights-sky': providerStatus({
				providerId: 'flights-sky',
				label: 'Flights Sky',
				lastError: { code: 'quota-exceeded', message: 'Quota used up.', status: 429 }
			})
		};

		const result = deriveScoredResult(g, { providers, done: true }, 1);

		expect(result.price.freshness.tier).toBe('expired-fallback');
		if (result.price.freshness.tier === 'expired-fallback') {
			expect(result.price.freshness.reason).toBe('quota-exceeded');
			expect(result.price.freshness.message).toBe('Quota used up.');
			// Age is measured from the OLDEST part (the outbound flight, fetched an hour
			// ago), the more conservative reading, not the freshest (5 minutes ago).
			expect(result.price.freshness.ageMs).toBeGreaterThanOrEqual(59 * 60_000);
		}
	});

	it('clears to fresh once a previously-failing provider succeeds again (no lastError)', () => {
		const g = group();
		const providers: Record<string, ProviderStatus> = {
			'flights-sky': providerStatus({ providerId: 'flights-sky', label: 'Flights Sky' })
			// lastError intentionally absent: ProviderStatus's own doc says a resolved
			// failure is cleared, never reported as still ongoing.
		};

		const result = deriveScoredResult(g, { providers, done: true }, 1);
		expect(result.price.freshness).toEqual({ tier: 'fresh' });
	});
});

describe('describeProviderError', () => {
	it('maps every ProviderError code to a ProviderIssueReason without throwing', () => {
		const codes = [
			{ code: 'missing-key', message: 'm' } as const,
			{ code: 'not-subscribed', message: 'm', status: 403 } as const,
			{ code: 'quota-exceeded', message: 'm', status: 429 } as const,
			{ code: 'network-error', message: 'm' } as const,
			{ code: 'malformed-response', message: 'm' } as const,
			{ code: 'cancelled', message: 'm' } as const,
			{ code: 'unknown', message: 'm' } as const
		];
		for (const error of codes) {
			expect(() => describeProviderError(error)).not.toThrow();
		}
	});

	it('keeps the original provider message rather than replacing it', () => {
		const { message } = describeProviderError({ code: 'quota-exceeded', message: 'Specific quota text', status: 429 });
		expect(message).toBe('Specific quota text');
	});
});

describe('widenOptionKey', () => {
	it('is stable for the same option and distinguishes tier and candidate', () => {
		const base: WidenOption = {
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Confirm via Skyscanner',
			candidateAirportCode: 'VIE',
			requests: 2,
			requiresKey: false
		};
		expect(widenOptionKey(base)).toBe(widenOptionKey({ ...base }));
		expect(widenOptionKey(base)).not.toBe(widenOptionKey({ ...base, tier: 'calendar' }));
		expect(widenOptionKey(base)).not.toBe(widenOptionKey({ ...base, candidateAirportCode: 'PRG' }));
	});
});

describe('summarizePriceCalendarOutcome', () => {
	it('names the cheapest day when the calendar call succeeds', () => {
		const outcome: PriceCalendarOutcome = {
			candidateAirportCode: 'VIE',
			leg: 'outbound',
			providerId: 'flights-sky',
			result: {
				ok: true,
				data: [
					{ date: '2026-10-14', group: 'medium', price: { minorUnits: 6400, currency: 'EUR' } },
					{ date: '2026-10-19', group: 'low', price: { minorUnits: 3300, currency: 'EUR' } }
				],
				source: { providerId: 'flights-sky', fetchedAt: new Date().toISOString() },
				requestsUsed: 1
			}
		};

		const summary = summarizePriceCalendarOutcome(outcome);
		expect(summary).toContain('2026-10-19');
		expect(summary).toContain('33.00');
	});

	it('reports the real reason when the calendar call fails, never a blank result', () => {
		const outcome: PriceCalendarOutcome = {
			candidateAirportCode: 'VIE',
			leg: 'onward',
			providerId: 'flights-sky',
			result: {
				ok: false,
				error: { code: 'quota-exceeded', message: 'Monthly quota used up.', status: 429 },
				source: { providerId: 'flights-sky', fetchedAt: new Date().toISOString() },
				requestsUsed: 1
			}
		};

		expect(summarizePriceCalendarOutcome(outcome)).toContain('Monthly quota used up.');
	});
});
