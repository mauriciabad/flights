import { describe, expect, it } from 'vitest';
import {
	canConvert,
	convertMinorUnits,
	exchangeRateProvenance,
	rateAgeInDays,
	ratesAreStale,
	RATES_STALE_AFTER_DAYS
} from './exchange-rates';
import { EXCHANGE_RATES as rates } from './exchange-rates.generated';

/**
 * Issue #339. The arithmetic that puts a ground fare estimate into the traveller's
 * currency, and the three ways it declines to.
 *
 * Every case pins a date explicitly. `convertMinorUnits` defaults to `new Date()`, so a
 * test that let it read the wall clock would start failing on its own once the committed
 * dataset aged past the ceiling, which is a test that measures the calendar rather than
 * the code.
 */

/** A day the committed dataset is comfortably fresh on. */
const SOON_AFTER = new Date(`${rates.referenceDate}T12:00:00Z`);

describe('crossing one currency into another', () => {
	it('converts through the euro, in both directions, at the published rates', () => {
		// 10000 pence at GBP 0.85898 to the euro is EUR 116.42, and the euro amount crossed
		// back lands on the pence it started from. Both legs are the same day's reference
		// rate, so the round trip is exact to the minor unit.
		const pounds = 10_000;
		const euros = convertMinorUnits(pounds, 'GBP', 'EUR', SOON_AFTER);
		expect(euros).toBe(Math.round((100 / rates.rates.GBP) * 100));
		expect(convertMinorUnits(euros!, 'EUR', 'GBP', SOON_AFTER)).toBe(pounds);
	});

	it('gives a euro amount back unchanged when the target is the euro', () => {
		// `rates.EUR` is written into the dataset as 1 rather than special-cased in the
		// lookup, and this is what says so.
		expect(convertMinorUnits(4237, 'EUR', 'EUR', SOON_AFTER)).toBe(4237);
	});

	it('crosses two non-euro currencies without either of them being the base', () => {
		const czk = convertMinorUnits(50_000, 'GBP', 'CZK', SOON_AFTER);
		expect(czk).toBe(Math.round((500 / rates.rates.GBP) * rates.rates.CZK * 100));
	});
});

describe('minor units are not interchangeable across currencies', () => {
	it('reads the yen as having no minor unit at all', () => {
		// The trap this test exists for: 10000 minor units is GBP 100.00 and JPY 10000,
		// because ISO 4217 gives the yen an exponent of 0. Multiplying minor units by a rate
		// without going through major units would be wrong by a factor of a hundred, which
		// is issue #179's HUF bug in a different currency.
		const yen = convertMinorUnits(10_000, 'GBP', 'JPY', SOON_AFTER);
		expect(yen).toBe(Math.round((100 / rates.rates.GBP) * rates.rates.JPY));
		// Sanity in plain terms: a hundred pounds is tens of thousands of yen, not hundreds.
		expect(yen).toBeGreaterThan(10_000);
	});

	it('reads the forint as having two, the way this repo settled in #179', () => {
		const forint = convertMinorUnits(10_000, 'GBP', 'HUF', SOON_AFTER);
		expect(forint).toBe(Math.round((100 / rates.rates.GBP) * rates.rates.HUF * 100));
	});
});

describe('declining to convert', () => {
	it('says no to a currency the ECB does not publish', () => {
		// Cape Verdean escudo, which is the currency of the acceptance trip's origin and is
		// exactly the sort of code an imported key file can name. A missing rate is not an
		// error: the caller keeps the rate card's own currency, which is true.
		expect(convertMinorUnits(1000, 'GBP', 'CVE', SOON_AFTER)).toBeUndefined();
		expect(convertMinorUnits(1000, 'CVE', 'EUR', SOON_AFTER)).toBeUndefined();
		expect(canConvert('GBP', 'CVE', SOON_AFTER)).toBe(false);
	});

	it('says no to rates past the staleness ceiling', () => {
		const wayLater = new Date(
			Date.parse(`${rates.referenceDate}T00:00:00Z`) + (RATES_STALE_AFTER_DAYS + 1) * 86_400_000
		);
		expect(ratesAreStale(wayLater)).toBe(true);
		expect(convertMinorUnits(1000, 'GBP', 'EUR', wayLater)).toBeUndefined();
		expect(canConvert('GBP', 'EUR', wayLater)).toBe(false);
	});

	it('says no when the clock is behind the dataset by more than a day', () => {
		// A machine whose clock is a year slow would otherwise read a future dataset as
		// freshly published. A clock that wrong is not evidence either way.
		const wayEarlier = new Date(Date.parse(`${rates.referenceDate}T00:00:00Z`) - 30 * 86_400_000);
		expect(ratesAreStale(wayEarlier)).toBe(true);
	});

	it('says no to an amount that is not a non-negative number', () => {
		expect(convertMinorUnits(Number.NaN, 'GBP', 'EUR', SOON_AFTER)).toBeUndefined();
		expect(convertMinorUnits(-1, 'GBP', 'EUR', SOON_AFTER)).toBeUndefined();
	});

	it('still converts right up to the ceiling', () => {
		// The other side of the staleness test, so a ceiling accidentally set to zero would
		// fail here rather than pass everything quietly by never converting.
		const justInside = new Date(
			Date.parse(`${rates.referenceDate}T00:00:00Z`) + (RATES_STALE_AFTER_DAYS - 1) * 86_400_000
		);
		expect(ratesAreStale(justInside)).toBe(false);
		expect(convertMinorUnits(10_000, 'GBP', 'EUR', justInside)).toBeGreaterThan(0);
	});
});

describe('the committed dataset', () => {
	it('carries a rate for every currency a taxi rate card is written in', () => {
		// `TAXI_RATE_TABLE` denominates its cards in these five and the fallback card in
		// EUR. A card whose currency the ECB does not publish would silently stop converting
		// for every ride in that country, which is a gap worth failing a build over rather
		// than discovering on a results page.
		for (const currency of ['EUR', 'GBP', 'CHF', 'SEK', 'CZK']) {
			expect(canConvert(currency, 'EUR', SOON_AFTER)).toBe(true);
		}
	});

	it('carries a rate for every currency the settings picker offers', () => {
		// Fourteen tiles in `settings/currencies.ts`. One of them missing here would mean a
		// traveller could pick a currency the estimate silently refuses to be shown in.
		const offered = ['EUR', 'GBP', 'USD', 'CHF', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK', 'AUD', 'NZD', 'SGD', 'JPY', 'HUF'];
		for (const currency of offered) {
			expect(canConvert('GBP', currency, SOON_AFTER)).toBe(true);
		}
	});

	it('is not already stale on the day it was committed', () => {
		// Guards the one failure the ceiling cannot catch by itself: a dataset committed
		// with a `referenceDate` that was already past it, which would ship a build that
		// never converts anything and looks exactly like the bug this issue fixed.
		expect(rateAgeInDays(SOON_AFTER)).toBeLessThan(RATES_STALE_AFTER_DAYS);
		expect(ratesAreStale(SOON_AFTER)).toBe(false);
	});

	it('reports the ECB reference day, not the day CI happened to run', () => {
		// The two stamps are up to a weekend apart and the older one is what dates a
		// converted figure. See `fetch-exchange-rates.mjs` on why both are kept.
		const provenance = exchangeRateProvenance();
		expect(provenance.referenceDate).toBe(rates.referenceDate);
		expect(Date.parse(provenance.fetchedAt)).toBeGreaterThanOrEqual(
			Date.parse(`${provenance.referenceDate}T00:00:00Z`)
		);
	});
});
