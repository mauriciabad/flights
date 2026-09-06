import { describe, expect, it } from 'vitest';
import { scoreItinerary } from '$lib/algorithm/score';
import type { ItineraryGroup, ItineraryResult, PriceCalendarOutcome, ProviderStatus, WidenOption } from '$lib/search';
import {
	affordableWidenOptions,
	describeProviderError,
	deriveScoredResult,
	groupWidenOptions,
	summarizePriceCalendarOutcome,
	widenOptionGroupKey,
	widenOptionKey
} from './types';
import type { WidenOptionGroup } from './types';
import { makeItinerary } from './test-support';

function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
	return {
		providerId: 'ryanair',
		kind: 'flight',
		label: 'Ryanair',
		requestsUsed: 1,
		okCalls: 1,
		okCallsWithData: 1,
		...overrides
	};
}

// A fetch timestamp is when a real network call actually happened, which is always
// close to "now" (whenever the test runs), never the fictional flight date the itinerary
// itself describes. A fixed past offset keeps `retrievedAgeMs` meaningfully positive regardless of
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
		expect(result.price.freshness.tier).toBe('fresh');
	});

	it('carries the oldest part’s real age on a finished search, not only on a failing one', () => {
		// Issue #146/#151's shared shape, in the results layer: `done` is a fact about the
		// search, and it used to be the only thing 'fresh' reported. A price served from
		// an hour-old cache is an hour old whether or not the search that surfaced it has
		// finished, and `view-model.ts` needs that number to stop calling it "Current".
		const g = group();
		const result = deriveScoredResult(g, { providers: {}, done: true }, 1);
		expect(result.price.freshness.retrievedAgeMs).toBeGreaterThanOrEqual(59 * 60_000);
	});

	it('is stale while the search is still running, even with no error', () => {
		const g = group();
		const result = deriveScoredResult(g, { providers: {}, done: false }, 1);
		expect(result.price.freshness.tier).toBe('stale');
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
			expect(result.price.freshness.retrievedAgeMs).toBeGreaterThanOrEqual(59 * 60_000);
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
		expect(result.price.freshness.tier).toBe('fresh');
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
			{ code: 'no-time-zone', message: 'm', airports: ['BVC'] } as const,
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

describe('groupWidenOptions', () => {
	function confirmOption(overrides: Partial<WidenOption> = {}): WidenOption {
		return {
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Skyscanner (RapidAPI)',
			candidateAirportCode: 'VIE',
			requests: 8,
			requiresKey: false,
			...overrides
		};
	}

	it('issue #96: folds one row per candidate into one row per provider and tier, summing cost', () => {
		const options = [
			confirmOption({ candidateAirportCode: 'VIE', requests: 8 }),
			confirmOption({ candidateAirportCode: 'PRG', requests: 6 }),
			confirmOption({ candidateAirportCode: 'MXP', requests: 10 })
		];

		const groups = groupWidenOptions(options);

		expect(groups).toHaveLength(1);
		expect(groups[0].providerId).toBe('skyscanner');
		expect(groups[0].tier).toBe('confirm');
		expect(groups[0].requests).toBe(24);
		expect(groups[0].options).toHaveLength(3);
	});

	it('keeps different providers, and the same provider across tiers, in separate rows', () => {
		const options = [
			confirmOption({ providerId: 'skyscanner', candidateAirportCode: 'VIE', requests: 8 }),
			confirmOption({ providerId: 'kiwi', candidateAirportCode: 'VIE', requests: 1 }),
			confirmOption({ providerId: 'skyscanner', tier: 'calendar', candidateAirportCode: 'VIE', requests: 2 })
		];

		const groups = groupWidenOptions(options);

		expect(groups).toHaveLength(3);
		const keys = groups.map((group) => widenOptionGroupKey(group));
		expect(new Set(keys).size).toBe(3);
	});

	it('carries requiresKey through unchanged, since every option in a group shares one provider', () => {
		const groups = groupWidenOptions([confirmOption({ requiresKey: true })]);
		expect(groups[0].requiresKey).toBe(true);
	});

	it('sorts cheapest group first, same as the underlying per-candidate options', () => {
		const options = [
			confirmOption({ providerId: 'kiwi', candidateAirportCode: 'VIE', requests: 20 }),
			confirmOption({ providerId: 'skyscanner', candidateAirportCode: 'VIE', requests: 8 })
		];
		const groups = groupWidenOptions(options);
		expect(groups.map((group) => group.providerId)).toEqual(['skyscanner', 'kiwi']);
	});

	it('returns nothing for an empty option list', () => {
		expect(groupWidenOptions([])).toEqual([]);
	});
});

describe('widenOptionGroupKey', () => {
	it('is stable for the same provider and tier, and ignores candidate', () => {
		const a = confirmOptionGroupInput({ candidateAirportCode: 'VIE' });
		const b = confirmOptionGroupInput({ candidateAirportCode: 'PRG' });
		expect(widenOptionGroupKey(a)).toBe(widenOptionGroupKey(b));
		expect(widenOptionGroupKey(a)).not.toBe(widenOptionGroupKey({ ...a, tier: 'calendar' }));
	});

	function confirmOptionGroupInput(overrides: Partial<WidenOption> = {}): WidenOption {
		return {
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Skyscanner (RapidAPI)',
			candidateAirportCode: 'VIE',
			requests: 8,
			requiresKey: false,
			...overrides
		};
	}
});

/**
 * Issue #244. The confirm row for the acceptance search covered five stopovers at once, and
 * the panel took the whole row away when their combined cost went over the provider's cap.
 * Sky Scrapper's cap is 15 (providers/budget/caps.ts, from a measured 20-a-month free tier),
 * so a search that ranked enough stopovers left the owner's configured key with nothing it
 * could ever be spent on.
 */
describe('affordableWidenOptions', () => {
	function group(perStopover: number, stopovers: string[]): WidenOptionGroup {
		const options: WidenOption[] = stopovers.map((code) => ({
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Skyscanner (RapidAPI)',
			candidateAirportCode: code,
			requests: perStopover,
			requiresKey: false
		}));
		return {
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Skyscanner (RapidAPI)',
			requests: options.reduce((sum, option) => sum + option.requests, 0),
			requiresKey: false,
			options
		};
	}

	it('offers the whole row when the month can pay for it', () => {
		// Six stopovers at two requests each is 12, inside Sky Scrapper's cap of 15.
		const fits = affordableWidenOptions(group(2, ['VIE', 'PRG', 'MXP', 'BUD', 'ZRH', 'MUC']), 15);
		expect(fits.requests).toBe(12);
		expect(fits.options).toHaveLength(6);
		expect(fits.skipped).toBe(0);
	});

	it('offers the stopovers that fit rather than none of them', () => {
		// Issue #115's fallback sweep can rank 24 stopovers, which is 48 requests.
		const codes = Array.from({ length: 24 }, (_, index) => `Z${String(index).padStart(2, '0')}`);
		const fits = affordableWidenOptions(group(2, codes), 15);

		expect(fits.options).toHaveLength(7);
		expect(fits.requests).toBe(14);
		expect(fits.skipped).toBe(17);
		expect(fits.requests).toBeLessThanOrEqual(15);
	});

	it('keeps the group order, so the best-ranked stopovers are the ones bought', () => {
		const fits = affordableWidenOptions(group(2, ['VIE', 'PRG', 'MXP']), 4);
		expect(fits.options.map((option) => option.candidateAirportCode)).toEqual(['VIE', 'PRG']);
	});

	it('offers nothing when even one stopover is out of reach', () => {
		const fits = affordableWidenOptions(group(2, ['VIE', 'PRG']), 1);
		expect(fits.options).toEqual([]);
		expect(fits.requests).toBe(0);
		expect(fits.skipped).toBe(2);
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

describe('deriveScoredResult, stopover lengths (issue #224)', () => {
	/** A group whose variants really differ in length, unlike the `group()` helper above,
	 * which repeats one result to vary only the count. Variants are handed over best score
	 * first, the order `groupItineraryResults` guarantees. */
	function ladder(nights: readonly number[]): ItineraryGroup {
		const variants = [...nights]
			.map((count) => {
				const itinerary = makeItinerary({ connectionAirportCode: 'LGW', nightsInConnection: count });
				return {
					score: scoreItinerary(itinerary),
					sources: {
						outboundFlight: { providerId: 'ryanair', fetchedAt: FIVE_MINUTES_AGO },
						onwardFlight: { providerId: 'ryanair', fetchedAt: FIVE_MINUTES_AGO }
					}
				} satisfies ItineraryResult;
			})
			.sort((a, b) => b.score.total - a.score.total);
		return { connectionAirportCode: 'LGW', best: variants[0], variants };
	}

	it('shows the shortest length when nothing has been asked for', () => {
		const result = deriveScoredResult(ladder([6, 3, 1]), { providers: {}, done: true }, 1);

		expect(result.itinerary.nightsInConnection).toBe(1);
		expect(result.stopover.minimum).toBe(1);
		expect(result.stopover.options.map((option) => option.nights)).toEqual([1, 3, 6]);
		expect(result.stopover.isFlightChange).toBe(false);
	});

	it('shows the length the traveller asked for', () => {
		const result = deriveScoredResult(ladder([6, 3, 1]), { providers: {}, done: true }, 1, { nights: 3 });

		expect(result.itinerary.nightsInConnection).toBe(3);
		// The baseline the card's "the price moved" line compares against never moves with
		// the selection: it is the trip the card offered and the list was ranked on.
		expect(result.stopover.minimumItinerary.nightsInConnection).toBe(1);
	});

	it('falls back to the shortest rather than the nearest when a length is gone', () => {
		// A length the traveller cannot have is not silently rounded to another trip.
		const result = deriveScoredResult(ladder([1, 6]), { providers: {}, done: true }, 1, { nights: 3 });

		expect(result.itinerary.nightsInConnection).toBe(1);
	});

	it('calls a city you can fly through in a day a flight change', () => {
		const result = deriveScoredResult(ladder([0, 2]), { providers: {}, done: true }, 1);

		expect(result.itinerary.nightsInConnection).toBe(0);
		expect(result.stopover.isFlightChange).toBe(true);
	});

	it('counts only the flight times at the length on screen', () => {
		// "+2 more flight times" has to mean two other ways to fly THIS trip. Pairings at
		// other lengths are other trips, with other totals, and the nights control is what
		// reaches them.
		const result = deriveScoredResult(ladder([1, 1, 4]), { providers: {}, done: true }, 1);

		expect(result.variantCount).toBe(2);
	});

	it('reads provenance off the length being shown, not off the shortest one', () => {
		const group = ladder([1, 2]);
		const extended = group.variants.find((variant) => variant.score.itinerary.nightsInConnection === 2);
		if (!extended) throw new Error('fixture lost its two-night variant');
		extended.sources = {
			outboundFlight: { providerId: 'ryanair', fetchedAt: ONE_HOUR_AGO },
			onwardFlight: { providerId: 'flights-sky', fetchedAt: ONE_HOUR_AGO }
		};

		const result = deriveScoredResult(group, { providers: {}, done: true }, 1, { nights: 2 });

		expect(result.price.parts.map((part) => part.providerId)).toEqual(['ryanair', 'flights-sky']);
	});
});
