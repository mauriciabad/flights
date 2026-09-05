/**
 * Issue #339: the euro reference rates that put a ground fare estimate in the currency the
 * traveller picked, fetched in CI (scripts/fetch-exchange-rates.mjs,
 * .github/workflows/exchange-rates.yml) and shipped as the committed
 * `exchange-rates.generated.ts` this module imports.
 *
 * ## The one thing this module converts, and the one thing it must never convert
 *
 * A `FareRange` from `providers/transfers/taxi-rate-table.ts`. Nothing else. Every other
 * price in this app is already in the traveller's currency because the app ASKED for it:
 * `SearchDependencies.currency` goes out on the query and the providers answer in it. The
 * rate card cannot be asked, because it is a table of municipal tariffs compiled here, so
 * it answers in the ride's country's currency and this is what closes the gap.
 *
 * It must never touch a `Money`. A quoted fare, a flight, a bed and `Itinerary.totalPrice`
 * are all money a provider really named, `sumMoney` throws on a currency mix by design,
 * and issue #152 was the bug where mixing them silently reached a total. Converting a
 * quote here would re-open that by a different door: the number would stop being the one
 * the provider said, while still being typed as though it were.
 *
 * ## Why a plain static import when every other dataset in this directory is lazy
 *
 * `airports.generated.json` is 816 KB, `cheap-routes` 324 KB, `ryanair-network` 38 KB, and
 * all three are behind a dynamic `import()` so they get their own chunk. This file is
 * under a kilobyte, so a chunk would cost more than it saves. It also has to be readable
 * synchronously: `estimateTaxiFare` is pure and synchronous on purpose (see its own
 * header), and making it async would push a promise through the OSRM adapter and every
 * caller of it, for thirty numbers.
 *
 * That static import is also why the generated file is a `.ts` module and not the `.json`
 * its four neighbours are. A static JSON import reaches Playwright's config loader, which
 * is plain Node ESM and rejects one without a `with { type: 'json' }` attribute: `CI=1
 * pnpm test:e2e` collected zero tests and printed that TypeError four times. The lazy
 * datasets never hit it, because nothing loads them at config time.
 *
 * ## What "no rate" means, and why it is not an error
 *
 * `convertMinorUnits` answers `undefined` for a currency the ECB does not publish, for a
 * dataset older than `RATES_STALE_AFTER_DAYS`, and for an amount that would not survive
 * the arithmetic. Every one of those is the same instruction to the caller: show the
 * original currency, unconverted, which is what the rate card actually says. That is the
 * honest fallback and it is also today's behaviour, so a missing rate degrades to the
 * state this feature replaced rather than to a blank or a guess.
 */

import type { IsoCurrencyCode } from '$lib/domain';
import { minorUnitsPerMajorUnit, normaliseCurrencyCode } from '$lib/domain';
import { EXCHANGE_RATES } from './exchange-rates.generated';

/**
 * How old these rates may be before the app stops converting with them, in days.
 *
 * One year, and the number is arguable, so here is the argument.
 *
 * This ceiling is NOT a precision threshold, because precision never becomes the binding
 * problem. Measured against these same ECB rates on 2026-09-05, the four non-euro
 * currencies the taxi rate cards are written in moved this much against the euro:
 *
 * | | 30 days | 3 months | 12 months |
 * | --- | --- | --- | --- |
 * | GBP | +0.21% | -0.62% | -1.02% |
 * | CHF | +0.64% | +2.51% | +0.16% |
 * | SEK | +1.25% | +2.15% | +0.90% |
 * | CZK | -0.02% | +0.10% | -0.95% |
 *
 * The estimate these rates convert spans a factor of about 1.6 between its own bounds: a
 * live measurement on 2026-09-05 put a Birmingham airport ride at £73.73-£116.46, a 58%
 * spread. A worst case of 2.51% is a twentieth of the uncertainty already on the screen,
 * so a rate a season old changes nothing a traveller could act on.
 *
 * What the ceiling is really for is liveness. `.github/workflows/exchange-rates.yml` runs
 * every weekday and `deploy.yml` ships continuously, so rates more than a few days old in
 * a running build mean that pipeline has stopped. A year is unambiguously "nobody is
 * maintaining this build any more" and it is the shortest window that cannot fire on a
 * project that is merely quiet for a season. Shorter would start refusing to convert on
 * repos that are fine; longer would keep converting at a rate nobody stands behind.
 */
export const RATES_STALE_AFTER_DAYS = 365;

/** The generated module's own shape carries the field docs; this alias is only so the rest
 * of the file reads as `RATES.rates` rather than as a shouted constant. `referenceDate` is
 * the ECB's clock and the older of the two stamps, which is why staleness is measured from
 * it rather than from `fetchedAt`. */
const RATES = EXCHANGE_RATES;

/** What the dataset says about itself, for a screen that wants to date a converted figure
 * rather than print it bare. */
export interface ExchangeRateProvenance {
	/** The ECB reference day these rates are for, `YYYY-MM-DD`. */
	referenceDate: string;
	/** The instant CI read them. Later than `referenceDate` by up to a weekend. */
	fetchedAt: string;
}

export function exchangeRateProvenance(): ExchangeRateProvenance {
	return { referenceDate: RATES.referenceDate, fetchedAt: RATES.fetchedAt };
}

/**
 * Days between the ECB's reference day for these rates and `now`, or `undefined` when the
 * stamp in the dataset is not a date at all. Exported for the test that asserts the
 * committed file is not already past the ceiling.
 */
export function rateAgeInDays(now: Date = new Date()): number | undefined {
	const referenceDay = Date.parse(`${RATES.referenceDate}T00:00:00Z`);
	if (!Number.isFinite(referenceDay)) return undefined;
	return (now.getTime() - referenceDay) / 86_400_000;
}

/** Whether these rates are past `RATES_STALE_AFTER_DAYS` and must not be converted with.
 * A dataset dated in the future is stale too: a clock that far wrong is not evidence. */
export function ratesAreStale(now: Date = new Date()): boolean {
	const age = rateAgeInDays(now);
	if (age === undefined) return true;
	return age > RATES_STALE_AFTER_DAYS || age < -1;
}

/** The euro reference rate for one currency, or `undefined` when the ECB does not publish
 * it. `rates.EUR` is 1, written into the dataset explicitly so this needs no special case
 * for its own base. */
function euroRate(currency: IsoCurrencyCode): number | undefined {
	const code = normaliseCurrencyCode(currency);
	if (code === undefined) return undefined;
	const rate = RATES.rates[code];
	return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Whether a fare in `currency` can be converted at all right now. Lets a caller skip the
 * arithmetic and keep the original, rather than converting one bound and not the other. */
export function canConvert(from: IsoCurrencyCode, to: IsoCurrencyCode, now: Date = new Date()): boolean {
	if (ratesAreStale(now)) return false;
	return euroRate(from) !== undefined && euroRate(to) !== undefined;
}

/**
 * `minorUnits` of `from` as minor units of `to`, or `undefined` when this app has no
 * business answering.
 *
 * Crossed through the euro, because that is the only shape the ECB publishes: divide out
 * of the source rate into euros, multiply into the target. Both legs are reference rates
 * for the same day, so the cross is as good as either.
 *
 * Minor units are NOT interchangeable across currencies and this is where that bites.
 * 1000 minor units is £10.00 and ¥1000, because ISO 4217 gives the yen no minor unit at
 * all. So the arithmetic goes through major units both ways using each currency's own
 * exponent (`domain/money.ts`, issue #179, where three adapters each answered that
 * question for themselves and two got HUF wrong by a factor of a hundred).
 *
 * `Math.round` at the end, never a cast, for the reason `moneyFromMajorUnits` gives:
 * truncating a binary-float product always loses in the same direction.
 */
export function convertMinorUnits(
	minorUnits: number,
	from: IsoCurrencyCode,
	to: IsoCurrencyCode,
	now: Date = new Date()
): number | undefined {
	if (!Number.isFinite(minorUnits) || minorUnits < 0) return undefined;
	if (ratesAreStale(now)) return undefined;
	const fromRate = euroRate(from);
	const toRate = euroRate(to);
	if (fromRate === undefined || toRate === undefined) return undefined;

	const majorUnits = minorUnits / minorUnitsPerMajorUnit(from);
	const converted = Math.round((majorUnits / fromRate) * toRate * minorUnitsPerMajorUnit(to));
	return Number.isSafeInteger(converted) ? converted : undefined;
}
