import { describe, expect, it } from 'vitest';
import type { Duration, FlightOffer, Money } from '../domain';
import type { ProviderId, ProviderResult } from '../providers/types';
import {
	RYANAIR_PROVIDER_ID,
	cheapestSourceNote,
	collectSourcedOffers,
	compareFlights,
	crosscheckOffers,
	identifyFlight,
	mergeCrosscheckSummaries,
	summarizeComparisons,
	type SourcedOffer
} from './crosscheck';

/**
 * All fixtures below are hand-built, matching AGENTS.md's "Tests off fixtures, no network"
 * for the algorithm layer. `crosscheck.ts` never fetches anything itself, so this is the
 * whole test surface: real network data (fetched separately, see the issue #17 comment) is
 * exercised through the same functions, just not from a test.
 */

const money = (minorUnits: number, currency = 'EUR'): Money => ({ minorUnits, currency });

function offer(overrides: Partial<FlightOffer> & { carrierCode: string }): FlightOffer {
	const { carrierCode, ...rest } = overrides;
	return {
		carrier: { iataCode: carrierCode, name: `${carrierCode} Airline` },
		flightNumber: `${carrierCode}1234`,
		departureAirport: 'BCN',
		arrivalAirport: 'STN',
		departure: { local: '2026-10-01T06:00:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 },
		arrival: { local: '2026-10-01T08:00:00', timeZone: 'Europe/London', utcOffsetMinutes: 60 },
		duration: 120 as Duration,
		price: money(4599),
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/book',
		...rest
	};
}

function from(providerId: ProviderId, o: FlightOffer): SourcedOffer {
	return { providerId, offer: o };
}

describe('identifyFlight', () => {
	it('normalises carrier-prefixed, spaced and bare flight numbers to the same identity', () => {
		const prefixed = identifyFlight(offer({ carrierCode: 'FR', flightNumber: 'FR1234' }));
		const spaced = identifyFlight(offer({ carrierCode: 'FR', flightNumber: 'fr 1234' }));
		const bare = identifyFlight(offer({ carrierCode: 'FR', flightNumber: '1234' }));

		expect(prefixed).toEqual({ carrier: 'FR', flightNumber: 'FR1234', departureDate: '2026-10-01' });
		expect(spaced).toEqual(prefixed);
		expect(bare).toEqual(prefixed);
	});

	it('takes the departure date from the local wall-clock date, not any UTC conversion', () => {
		// 00:30 local in Madrid is still "2026-10-02" on the departure airport's clock even
		// though it is already 2026-10-01 in UTC (AGENTS.md "Timezones") — the identity must
		// key on the local date, or a late-night flight would silently fail to match itself
		// across two providers that both report the correct local time.
		const lateNight = offer({
			carrierCode: 'FR',
			departure: { local: '2026-10-02T00:30:00', timeZone: 'Europe/Madrid', utcOffsetMinutes: 120 }
		});
		expect(identifyFlight(lateNight).departureDate).toBe('2026-10-02');
	});
});

describe('compareFlights — matching', () => {
	it('does not report a comparison for a flight only one provider quoted', () => {
		const comparisons = compareFlights([from('skyscanner', offer({ carrierCode: 'FR' }))]);
		expect(comparisons).toHaveLength(0);
	});

	it('does not match two different flights just because they share a route and a similar price', () => {
		// The exact failure mode the header warns against: same route, same rough price,
		// different flight entirely.
		const a = from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR1111', price: money(4500) }));
		const b = from('agoda', offer({ carrierCode: 'FR', flightNumber: 'FR2222', price: money(4500) }));
		expect(compareFlights([a, b])).toHaveLength(0);
	});

	it('matches the same flight across providers despite differing flight-number formatting', () => {
		const a = from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR1234', price: money(4000) }));
		const b = from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR 1234', price: money(4500) }));
		const comparisons = compareFlights([a, b]);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0].quotes.map((q) => q.providerId).sort()).toEqual(['ryanair', 'skyscanner']);
	});

	it('excludes a matched flight number+date whose providers disagree on the route', () => {
		// Same carrier, flight number and date, but a different departure/arrival pair -
		// one of the two adapters has a bad record. That is a data-quality problem, not a
		// price disagreement, so it must not be reported as one.
		const a = from('ryanair', offer({ carrierCode: 'FR', departureAirport: 'BCN', arrivalAirport: 'STN' }));
		const b = from('skyscanner', offer({ carrierCode: 'FR', departureAirport: 'BCN', arrivalAirport: 'LTN' }));
		const [comparison] = compareFlights([a, b]);
		expect(comparison.comparable).toBe(false);
		expect(comparison.cheapestProviderIds).toEqual([]);
		expect(comparison.groundTruthDisagreements).toEqual([]);
	});

	it('keeps only the cheapest offer per provider when one provider quotes several fare brands', () => {
		const basic = from(
			'skyscanner',
			offer({ carrierCode: 'FR', price: money(5000), fareBrand: 'Basic' })
		);
		const plus = from('skyscanner', offer({ carrierCode: 'FR', price: money(6500), fareBrand: 'Plus' }));
		const ryanair = from('ryanair', offer({ carrierCode: 'FR', price: money(4000) }));

		const [comparison] = compareFlights([basic, plus, ryanair]);
		expect(comparison.quotes).toHaveLength(2);
		const skyscannerQuote = comparison.quotes.find((q) => q.providerId === 'skyscanner');
		expect(skyscannerQuote?.price.minorUnits).toBe(5000);
	});
});

describe('compareFlights — cheapest source', () => {
	it('names the single cheapest provider', () => {
		const a = from('ryanair', offer({ carrierCode: 'FR', price: money(4000) }));
		const b = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500) }));
		const [comparison] = compareFlights([a, b]);
		expect(comparison.comparable).toBe(true);
		expect(comparison.cheapestProviderIds).toEqual(['ryanair']);
	});

	it('lists every provider tied for cheapest, not an arbitrary single winner', () => {
		const a = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500) }));
		const b = from('agoda', offer({ carrierCode: 'FR', price: money(4500) }));
		const [comparison] = compareFlights([a, b]);
		expect([...comparison.cheapestProviderIds].sort()).toEqual(['agoda', 'skyscanner']);
	});

	it('treats a currency mismatch as not comparable rather than comparing minor units across currencies', () => {
		const a = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500, 'EUR') }));
		const b = from('agoda', offer({ carrierCode: 'FR', price: money(500, 'USD') }));
		const [comparison] = compareFlights([a, b]);
		expect(comparison.comparable).toBe(false);
		expect(comparison.cheapestProviderIds).toEqual([]);
	});
});

describe('compareFlights — Ryanair as ground truth', () => {
	it('flags an aggregator quoting MORE than Ryanair for the exact same flight, with the right amount', () => {
		const truth = from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR1234', price: money(4000) }));
		const overquoting = from(
			'skyscanner',
			offer({ carrierCode: 'FR', flightNumber: 'FR1234', price: money(4599) })
		);

		const [comparison] = compareFlights([truth, overquoting]);
		expect(comparison.groundTruth?.providerId).toBe(RYANAIR_PROVIDER_ID);
		expect(comparison.groundTruthDisagreements).toEqual([
			{
				identity: comparison.identity,
				providerId: 'skyscanner',
				quotedPrice: money(4599),
				groundTruthPrice: money(4000),
				differenceMinorUnits: 599
			}
		]);
	});

	it('flags an aggregator quoting LESS than Ryanair too, with a negative difference', () => {
		const truth = from('ryanair', offer({ carrierCode: 'FR', price: money(4000) }));
		const underquoting = from('agoda', offer({ carrierCode: 'FR', price: money(3500) }));

		const [comparison] = compareFlights([truth, underquoting]);
		expect(comparison.groundTruthDisagreements[0].differenceMinorUnits).toBe(-500);
	});

	it('reports no disagreement when an aggregator matches Ryanair exactly', () => {
		const truth = from('ryanair', offer({ carrierCode: 'FR', price: money(4000) }));
		const matching = from('skyscanner', offer({ carrierCode: 'FR', price: money(4000) }));
		const [comparison] = compareFlights([truth, matching]);
		expect(comparison.groundTruthDisagreements).toEqual([]);
	});

	it('has no ground-truth field at all when Ryanair did not quote this flight', () => {
		const a = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500) }));
		const b = from('agoda', offer({ carrierCode: 'FR', price: money(4600) }));
		const [comparison] = compareFlights([a, b]);
		expect(comparison.groundTruth).toBeUndefined();
		expect(comparison.groundTruthDisagreements).toEqual([]);
	});

	it('never treats a route-mismatched record as a ground-truth disagreement', () => {
		const truth = from('ryanair', offer({ carrierCode: 'FR', arrivalAirport: 'STN', price: money(4000) }));
		const wrongRoute = from(
			'skyscanner',
			offer({ carrierCode: 'FR', arrivalAirport: 'LTN', price: money(9999) })
		);
		const [comparison] = compareFlights([truth, wrongRoute]);
		expect(comparison.groundTruthDisagreements).toEqual([]);
	});
});

describe('cheapestSourceNote', () => {
	it('names the winner and its price for a single cheapest provider', () => {
		const a = from('ryanair', offer({ carrierCode: 'FR', price: money(4000) }));
		const b = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500) }));
		const [comparison] = compareFlights([a, b]);
		const note = cheapestSourceNote(comparison);
		expect(note?.cheapestProviderIds).toEqual(['ryanair']);
		expect(note?.message).toContain('ryanair');
		expect(note?.message).toContain('€40.00');
	});

	it('is undefined for an incomparable (currency-mismatched) comparison', () => {
		const a = from('skyscanner', offer({ carrierCode: 'FR', price: money(4500, 'EUR') }));
		const b = from('agoda', offer({ carrierCode: 'FR', price: money(500, 'USD') }));
		const [comparison] = compareFlights([a, b]);
		expect(cheapestSourceNote(comparison)).toBeUndefined();
	});
});

describe('summarizeComparisons and mergeCrosscheckSummaries', () => {
	it('counts comparisons, wins and overpayment per provider within a currency', () => {
		const flight1 = compareFlights([
			from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR1', price: money(4000) })),
			from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR1', price: money(4500) }))
		]);
		const flight2 = compareFlights([
			from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR2', price: money(3000) })),
			from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR2', price: money(3000) }))
		]);

		const summary = summarizeComparisons([...flight1, ...flight2]);
		expect(summary.comparisonsConsidered).toBe(2);
		expect(summary.incomparableComparisons).toBe(0);

		const eur = summary.byCurrency['EUR'];
		expect(eur.comparisons).toBe(2);
		expect(eur.providers['ryanair']).toEqual({
			providerId: 'ryanair',
			comparisons: 2,
			timesCheapest: 2,
			timesMoreExpensive: 0,
			totalOverpaidMinorUnits: 0
		});
		expect(eur.providers['skyscanner']).toEqual({
			providerId: 'skyscanner',
			comparisons: 2,
			// Tied on flight 2, so skyscanner is "cheapest" there too.
			timesCheapest: 1,
			timesMoreExpensive: 1,
			totalOverpaidMinorUnits: 500
		});
	});

	it('excludes route- and currency-mismatched comparisons from byCurrency but counts them', () => {
		const mismatched = compareFlights([
			from('skyscanner', offer({ carrierCode: 'FR', price: money(4500, 'EUR') })),
			from('agoda', offer({ carrierCode: 'FR', price: money(500, 'USD') }))
		]);
		const summary = summarizeComparisons(mismatched);
		expect(summary.comparisonsConsidered).toBe(1);
		expect(summary.incomparableComparisons).toBe(1);
		expect(summary.byCurrency).toEqual({});
	});

	it('carries ground-truth disagreements through into the summary untouched', () => {
		const comparisons = compareFlights([
			from('ryanair', offer({ carrierCode: 'FR', price: money(4000) })),
			from('skyscanner', offer({ carrierCode: 'FR', price: money(4599) }))
		]);
		const summary = summarizeComparisons(comparisons);
		expect(summary.groundTruthDisagreements).toHaveLength(1);
		expect(summary.groundTruthDisagreements[0].differenceMinorUnits).toBe(599);
	});

	it('merges two summaries by adding every count, so results accumulate across separate searches', () => {
		const first = summarizeComparisons(
			compareFlights([
				from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR1', price: money(4000) })),
				from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR1', price: money(4500) }))
			])
		);
		const second = summarizeComparisons(
			compareFlights([
				from('ryanair', offer({ carrierCode: 'FR', flightNumber: 'FR2', price: money(3000) })),
				from('skyscanner', offer({ carrierCode: 'FR', flightNumber: 'FR2', price: money(3200) }))
			])
		);

		const merged = mergeCrosscheckSummaries(first, second);
		expect(merged.comparisonsConsidered).toBe(2);
		expect(merged.byCurrency['EUR'].providers['ryanair']?.timesCheapest).toBe(2);
		expect(merged.byCurrency['EUR'].providers['skyscanner']?.totalOverpaidMinorUnits).toBe(700);
		expect(merged.groundTruthDisagreements).toHaveLength(2);
	});

	it('merging is symmetric regardless of which side already has data for a currency or provider', () => {
		const empty = summarizeComparisons([]);
		const populated = summarizeComparisons(
			compareFlights([
				from('ryanair', offer({ carrierCode: 'FR', price: money(4000) })),
				from('skyscanner', offer({ carrierCode: 'FR', price: money(4500) }))
			])
		);
		expect(mergeCrosscheckSummaries(empty, populated)).toEqual(mergeCrosscheckSummaries(populated, empty));
	});
});

describe('collectSourcedOffers', () => {
	it('flattens ok results into sourced offers and drops failed ones entirely', () => {
		const results: ProviderResult<readonly FlightOffer[]>[] = [
			{
				ok: true,
				data: [offer({ carrierCode: 'FR' })],
				source: { providerId: 'ryanair', fetchedAt: '2026-09-04T00:00:00Z' },
				requestsUsed: 1
			},
			{
				ok: false,
				error: { code: 'quota-exceeded', message: 'quota exceeded', status: 429 },
				source: { providerId: 'skyscanner', fetchedAt: '2026-09-04T00:00:00Z' },
				requestsUsed: 1
			}
		];
		const sourced = collectSourcedOffers(results);
		expect(sourced).toHaveLength(1);
		expect(sourced[0].providerId).toBe('ryanair');
	});
});

describe('crosscheckOffers', () => {
	it('produces both comparisons and a matching summary from one call', () => {
		const offers: SourcedOffer[] = [
			from('ryanair', offer({ carrierCode: 'FR', price: money(4000) })),
			from('skyscanner', offer({ carrierCode: 'FR', price: money(4599) }))
		];
		const { comparisons, summary } = crosscheckOffers(offers);
		expect(comparisons).toHaveLength(1);
		expect(summary.comparisonsConsidered).toBe(1);
		expect(summary.groundTruthDisagreements).toHaveLength(1);
	});
});
