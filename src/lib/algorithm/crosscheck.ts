/**
 * Cross-provider price check. Issue #17: the owner's claim —
 *
 * > Travelpayouts seems like a good option but you must make sure it gives the cheapest
 * > results, in my experience skyscanner has always the cheapest price and agoda as well
 *
 * — is a thing to measure, not a thing to assume. This module measures it.
 *
 * The comparison this file performs is: for the SAME flight (same carrier, same flight
 * number, same departure date) quoted by two or more providers, which one is cheaper, by
 * how much, and how often. Matching on route and price alone would find offers that merely
 * look alike — two providers can both have a BCN-STN flight around €40 without it being
 * the same seat on the same aircraft. Matching on carrier + flight number + date pins it to
 * one specific scheduled departure, so a price difference is a fact about that flight
 * rather than a coincidence between two similar-looking ones.
 *
 * Ryanair is treated as ground truth for its own flights: those fares come from the
 * airline's own feed (docs/PROVIDERS.md), so when an aggregator quotes a different price
 * for the same flight number and date, the aggregator is measurably wrong, not just
 * "different." No other provider gets this treatment — an aggregator disagreeing with
 * another aggregator is a disagreement, not an error, since neither is the airline itself.
 *
 * No adapter for Ryanair exists in this codebase yet (a separate issue owns it). Rather
 * than build a second Ryanair client to unblock this module, ground truth here is wired to
 * whichever adapter eventually registers under `RYANAIR_PROVIDER_ID` — the narrow interface
 * this module actually needs is "some provider id names the Ryanair adapter," nothing more.
 * If that adapter lands under a different id, update the one constant below.
 *
 * Types only depend on `../domain` and `../providers/types`, and this file does no I/O of
 * its own: it consumes `SourcedOffer[]` that a caller has already fetched (or, in tests, a
 * fixture has already fabricated), and produces plain data. That keeps it testable with no
 * network and reusable from a live search pipeline, a one-off research script, or a
 * settings-page store equally.
 */

import type { FlightOffer, IataAirlineCode, IsoCalendarDate, Money, IsoCurrencyCode } from '../domain';
import type { ProviderId, ProviderResult } from '../providers/types';

/** The provider id the real Ryanair adapter is expected to register under (see this file's
 * header). A single named constant rather than a hardcoded string at every call site, so
 * wiring up the real adapter — or discovering it used a different id — is a one-line fix. */
export const RYANAIR_PROVIDER_ID: ProviderId = 'ryanair';

/** One priced offer plus which adapter produced it. The unit this whole module operates on:
 * a caller assembles these from however many providers it has live results for (as few as
 * one, as many as every registered flight adapter), in any order, and everything else here
 * is pure computation over the list. */
export interface SourcedOffer {
	providerId: ProviderId;
	offer: FlightOffer;
}

/** Builds `SourcedOffer[]` straight from what `FlightProvider.searchOffers` actually
 * returns — the shape a real search pipeline has on hand — so a caller never has to
 * hand-unwrap `ProviderResult` itself. Failed results contribute nothing, which is correct:
 * a 403 or a timeout is not a $0 quote. */
export function collectSourcedOffers(
	results: readonly ProviderResult<readonly FlightOffer[]>[]
): SourcedOffer[] {
	const sourced: SourcedOffer[] = [];
	for (const result of results) {
		if (!result.ok) continue;
		for (const offer of result.data) {
			sourced.push({ providerId: result.source.providerId, offer });
		}
	}
	return sourced;
}

/** What pins one specific scheduled departure down, independent of which provider is
 * describing it. */
export interface FlightIdentity {
	readonly carrier: IataAirlineCode;
	/** Normalised (see `normalizeFlightNumber`): uppercase, no whitespace, always
	 * carrier-prefixed, so "FR1234", "fr 1234" and "1234" from three different providers'
	 * adapters all identify the same flight instead of silently missing each other. */
	readonly flightNumber: string;
	/** The departure's calendar date, local to the departure airport (the same convention
	 * `LocalDateTime` uses everywhere else in this codebase — AGENTS.md "Timezones"). */
	readonly departureDate: IsoCalendarDate;
}

function normalizeFlightNumber(carrierCode: string, flightNumber: string): string {
	const compact = flightNumber.toUpperCase().replace(/\s+/g, '');
	const carrier = carrierCode.toUpperCase();
	return compact.startsWith(carrier) ? compact : `${carrier}${compact}`;
}

/** Identifies the flight an offer describes, for grouping across providers. */
export function identifyFlight(offer: FlightOffer): FlightIdentity {
	return {
		carrier: offer.carrier.iataCode,
		flightNumber: normalizeFlightNumber(offer.carrier.iataCode, offer.flightNumber),
		departureDate: offer.departure.local.slice(0, 10) as IsoCalendarDate
	};
}

function identityKey(identity: FlightIdentity): string {
	return `${identity.carrier}|${identity.flightNumber}|${identity.departureDate}`;
}

/** One provider's best price for a specific identified flight. When a provider returns more
 * than one offer for the same identity (e.g. Basic and Plus fare brands on the same flight),
 * this keeps the cheapest — a traveller choosing between providers is choosing between each
 * provider's best price, not its worst. */
export interface ProviderQuote {
	providerId: ProviderId;
	price: Money;
	offer: FlightOffer;
}

/** One case where a non-Ryanair provider quoted a different price than Ryanair's own feed
 * for the exact same flight. This is the "measurable fact" docs/PROVIDERS.md describes,
 * not a hedge: Ryanair fares come from the airline itself, so a different number for the
 * same flight number and date is the aggregator's own data being wrong. */
export interface GroundTruthDisagreement {
	identity: FlightIdentity;
	providerId: ProviderId;
	quotedPrice: Money;
	groundTruthPrice: Money;
	/** `quotedPrice.minorUnits - groundTruthPrice.minorUnits`. Positive: the provider quoted
	 * more than Ryanair itself. Negative: the provider quoted less, which is the more
	 * surprising direction and worth flagging just as loudly (a scraped or stale fare, most
	 * likely, but that is exactly the kind of thing this module exists to surface). */
	differenceMinorUnits: number;
}

/** Every provider's price for one identified flight, and what follows from comparing them. */
export interface FlightPriceComparison {
	identity: FlightIdentity;
	/** One entry per provider that quoted this flight, in no particular order. */
	quotes: readonly ProviderQuote[];
	/** False when the providers quoted this flight in different currencies (no exchange
	 * rate lives in this module, so minor units are not comparable across currencies — see
	 * AGENTS.md "Money") or disagreed about the departure/arrival airports for what they
	 * both call the same carrier + flight number + date (a data-quality problem in one of
	 * the two adapters, not a price disagreement to report). Every price-comparison field
	 * below is empty when this is false, rather than guessing. */
	comparable: boolean;
	/** Every provider tied for the lowest price — plural because a tie is real and picking
	 * one arbitrarily would misreport it as a single winner. Empty when `comparable` is
	 * false. */
	cheapestProviderIds: readonly ProviderId[];
	/** This flight's quote from the Ryanair adapter, when one was in the input. */
	groundTruth?: ProviderQuote;
	/** Always computed when `groundTruth` is present, regardless of `comparable` — a
	 * same-currency disagreement with the airline's own feed is worth reporting even when a
	 * third provider's mismatched currency makes the OTHER providers incomparable to each
	 * other. */
	groundTruthDisagreements: readonly GroundTruthDisagreement[];
}

/** Groups `offers` into per-flight comparisons and computes cheapest-source and
 * ground-truth-disagreement facts for each. A group with only one distinct provider is
 * dropped — there is nothing to cross-check a single source against. */
export function compareFlights(offers: readonly SourcedOffer[]): FlightPriceComparison[] {
	const buckets = new Map<string, SourcedOffer[]>();
	for (const sourced of offers) {
		const key = identityKey(identifyFlight(sourced.offer));
		const bucket = buckets.get(key);
		if (bucket) bucket.push(sourced);
		else buckets.set(key, [sourced]);
	}

	const comparisons: FlightPriceComparison[] = [];
	for (const bucket of buckets.values()) {
		if (new Set(bucket.map((s) => s.providerId)).size < 2) continue;

		const identity = identifyFlight(bucket[0].offer);

		// Same carrier + flight number + date but a different route between two providers
		// means one of them has the wrong flight, not a wrong price. Reporting a price
		// "disagreement" there would be exactly the coincidence-detector failure mode this
		// module exists to avoid, so it is excluded from price comparison entirely.
		const routes = new Set(bucket.map((s) => `${s.offer.departureAirport}-${s.offer.arrivalAirport}`));
		const routeMismatch = routes.size > 1;

		// Cheapest offer per provider for this identity (see ProviderQuote's doc comment).
		const byProvider = new Map<ProviderId, ProviderQuote>();
		for (const sourced of bucket) {
			const existing = byProvider.get(sourced.providerId);
			if (!existing || sourced.offer.price.minorUnits < existing.price.minorUnits) {
				byProvider.set(sourced.providerId, {
					providerId: sourced.providerId,
					price: sourced.offer.price,
					offer: sourced.offer
				});
			}
		}
		const quotes = Array.from(byProvider.values());
		const singleCurrency = new Set(quotes.map((q) => q.price.currency)).size === 1;
		const comparable = singleCurrency && !routeMismatch;

		let cheapestProviderIds: ProviderId[] = [];
		if (comparable) {
			const min = Math.min(...quotes.map((q) => q.price.minorUnits));
			cheapestProviderIds = quotes.filter((q) => q.price.minorUnits === min).map((q) => q.providerId);
		}

		const groundTruth = byProvider.get(RYANAIR_PROVIDER_ID);
		const groundTruthDisagreements: GroundTruthDisagreement[] = [];
		if (groundTruth && !routeMismatch) {
			for (const quote of quotes) {
				if (quote.providerId === RYANAIR_PROVIDER_ID) continue;
				if (quote.price.currency !== groundTruth.price.currency) continue;
				if (quote.price.minorUnits === groundTruth.price.minorUnits) continue;
				groundTruthDisagreements.push({
					identity,
					providerId: quote.providerId,
					quotedPrice: quote.price,
					groundTruthPrice: groundTruth.price,
					differenceMinorUnits: quote.price.minorUnits - groundTruth.price.minorUnits
				});
			}
		}

		comparisons.push({
			identity,
			quotes,
			comparable,
			cheapestProviderIds,
			groundTruth,
			groundTruthDisagreements
		});
	}
	return comparisons;
}

/** A human-readable, per-result note: which provider(s) were cheapest for one flight, and
 * what they charged. What the brief calls a "cheapest source" note on a search result. */
export interface CheapestSourceNote {
	identity: FlightIdentity;
	cheapestProviderIds: readonly ProviderId[];
	cheapestPrice: Money;
	message: string;
}

/** `undefined` when the comparison has nothing safe to say (currency mismatch or route
 * mismatch) — the caller should show nothing rather than a guess. */
export function cheapestSourceNote(comparison: FlightPriceComparison): CheapestSourceNote | undefined {
	if (!comparison.comparable || comparison.cheapestProviderIds.length === 0) return undefined;
	const cheapestPrice = comparison.quotes.find(
		(q) => q.providerId === comparison.cheapestProviderIds[0]
	)?.price;
	if (!cheapestPrice) return undefined;

	const flight = `${comparison.identity.carrier} ${comparison.identity.flightNumber} on ${comparison.identity.departureDate}`;
	const formatted = formatMoney(cheapestPrice);
	const message =
		comparison.cheapestProviderIds.length === 1
			? `${comparison.cheapestProviderIds[0]} is cheapest at ${formatted} for ${flight}.`
			: `${comparison.cheapestProviderIds.join(' and ')} tie for cheapest at ${formatted} for ${flight}.`;

	return { identity: comparison.identity, cheapestProviderIds: comparison.cheapestProviderIds, cheapestPrice, message };
}

// Display only — never the canonical value (AGENTS.md "Money"). `Intl` already knows how
// many decimal places each currency uses (0 for JPY, 3 for KWD, 2 for most), which is
// exactly the information needed to turn integer minor units back into a display amount
// without this module hardcoding a currency-to-exponent table of its own.
function formatMoney(money: Money): string {
	const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: money.currency });
	const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(money.minorUnits / 10 ** digits);
}

/** One provider's track record within one currency: how often it was in a comparison, how
 * often it won, and how much it cost to not win. Split by currency because summing money
 * across currencies without a conversion rate would produce a number that means nothing —
 * the same reason `FlightPriceComparison.comparable` exists. */
export interface ProviderStanding {
	providerId: ProviderId;
	comparisons: number;
	timesCheapest: number;
	timesMoreExpensive: number;
	/** Sum, over every comparison this provider did not win, of how much more it charged
	 * than the cheapest quote that comparison. */
	totalOverpaidMinorUnits: number;
}

export interface CurrencyCrosscheckStats {
	currency: IsoCurrencyCode;
	comparisons: number;
	providers: Readonly<Record<ProviderId, ProviderStanding>>;
}

/** The whole point of issue #17, in one shape a settings screen can render directly:
 * per-currency provider standings, and every flight where a non-Ryanair provider disagreed
 * with Ryanair's own fare. Built to accumulate: `mergeCrosscheckSummaries` combines one of
 * these with a persisted running total, so the picture gets more reliable across many real
 * searches over time rather than needing one large one-off run (this module does not
 * persist anything itself — see this file's header on scope). */
export interface CrosscheckSummary {
	/** Every matched flight seen from two or more providers, comparable or not. */
	comparisonsConsidered: number;
	/** Matched flights excluded from every field below because their providers quoted
	 * different currencies or disagreed about the route. */
	incomparableComparisons: number;
	byCurrency: Readonly<Record<IsoCurrencyCode, CurrencyCrosscheckStats>>;
	groundTruthDisagreements: readonly GroundTruthDisagreement[];
}

/** Folds a batch of comparisons (typically: everything from one search) into a summary. */
export function summarizeComparisons(comparisons: readonly FlightPriceComparison[]): CrosscheckSummary {
	let incomparableComparisons = 0;
	const byCurrency = new Map<
		IsoCurrencyCode,
		{ comparisons: number; providers: Map<ProviderId, ProviderStanding> }
	>();
	const groundTruthDisagreements: GroundTruthDisagreement[] = [];

	for (const comparison of comparisons) {
		groundTruthDisagreements.push(...comparison.groundTruthDisagreements);
		if (!comparison.comparable) {
			incomparableComparisons++;
			continue;
		}

		const currency = comparison.quotes[0].price.currency;
		let bucket = byCurrency.get(currency);
		if (!bucket) {
			bucket = { comparisons: 0, providers: new Map() };
			byCurrency.set(currency, bucket);
		}
		bucket.comparisons++;

		const cheapestMinorUnits = Math.min(...comparison.quotes.map((q) => q.price.minorUnits));
		for (const quote of comparison.quotes) {
			let standing = bucket.providers.get(quote.providerId);
			if (!standing) {
				standing = {
					providerId: quote.providerId,
					comparisons: 0,
					timesCheapest: 0,
					timesMoreExpensive: 0,
					totalOverpaidMinorUnits: 0
				};
				bucket.providers.set(quote.providerId, standing);
			}
			standing.comparisons++;
			if (quote.price.minorUnits === cheapestMinorUnits) {
				standing.timesCheapest++;
			} else {
				standing.timesMoreExpensive++;
				standing.totalOverpaidMinorUnits += quote.price.minorUnits - cheapestMinorUnits;
			}
		}
	}

	const byCurrencyResult: Record<IsoCurrencyCode, CurrencyCrosscheckStats> = {};
	for (const [currency, bucket] of byCurrency) {
		byCurrencyResult[currency] = {
			currency,
			comparisons: bucket.comparisons,
			providers: Object.fromEntries(bucket.providers)
		};
	}

	return {
		comparisonsConsidered: comparisons.length,
		incomparableComparisons,
		byCurrency: byCurrencyResult,
		groundTruthDisagreements
	};
}

/** Combines two summaries field-by-field — everything here is a count or a sum, so merging
 * is addition all the way down. This is what lets the app accumulate evidence over many real
 * searches: persist the running `CrosscheckSummary` (settings store, issue #3's BYOK
 * persistence, or similar — not this module's concern), merge each new search's summary into
 * it, and the settings screen always renders the up-to-date total. */
export function mergeCrosscheckSummaries(a: CrosscheckSummary, b: CrosscheckSummary): CrosscheckSummary {
	const currencies = new Set([...Object.keys(a.byCurrency), ...Object.keys(b.byCurrency)]);
	const byCurrency: Record<IsoCurrencyCode, CurrencyCrosscheckStats> = {};
	for (const currency of currencies) {
		const ca = a.byCurrency[currency];
		const cb = b.byCurrency[currency];
		const providerIds = new Set([
			...Object.keys(ca?.providers ?? {}),
			...Object.keys(cb?.providers ?? {})
		]);
		const providers: Record<ProviderId, ProviderStanding> = {};
		for (const id of providerIds) {
			const pa = ca?.providers[id];
			const pb = cb?.providers[id];
			providers[id] = {
				providerId: id,
				comparisons: (pa?.comparisons ?? 0) + (pb?.comparisons ?? 0),
				timesCheapest: (pa?.timesCheapest ?? 0) + (pb?.timesCheapest ?? 0),
				timesMoreExpensive: (pa?.timesMoreExpensive ?? 0) + (pb?.timesMoreExpensive ?? 0),
				totalOverpaidMinorUnits: (pa?.totalOverpaidMinorUnits ?? 0) + (pb?.totalOverpaidMinorUnits ?? 0)
			};
		}
		byCurrency[currency] = {
			currency,
			comparisons: (ca?.comparisons ?? 0) + (cb?.comparisons ?? 0),
			providers
		};
	}

	return {
		comparisonsConsidered: a.comparisonsConsidered + b.comparisonsConsidered,
		incomparableComparisons: a.incomparableComparisons + b.incomparableComparisons,
		byCurrency,
		groundTruthDisagreements: [...a.groundTruthDisagreements, ...b.groundTruthDisagreements]
	};
}

/** One call for the common case: turn a pile of sourced offers into both the per-flight
 * comparisons (drive the per-result "cheapest source" notes) and the summary (drive the
 * settings screen), in one pass. */
export function crosscheckOffers(offers: readonly SourcedOffer[]): {
	comparisons: readonly FlightPriceComparison[];
	summary: CrosscheckSummary;
} {
	const comparisons = compareFlights(offers);
	return { comparisons, summary: summarizeComparisons(comparisons) };
}
