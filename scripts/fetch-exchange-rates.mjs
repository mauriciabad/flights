#!/usr/bin/env node
// Issue #339: the euro reference rates the ground-fare estimate is converted with,
// compiled into a committed module at build time the way scripts/fetch-cheap-routes.mjs
// already compiles Travelpayouts fares and scripts/prepare-flags.mjs the flag code list.
//
// Why a build step rather than a fetch from the browser, which the no-backend rule would
// have allowed: the thing being converted is itself a static local table. The rate cards
// in src/lib/providers/transfers/taxi-rate-table.ts are municipal tariffs checked once, on
// 2026-09-04, and they produce a range whose high bound is around 1.6x its low. Measured
// against these same ECB rates on 2026-09-05, the four source currencies the table uses
// moved at most 2.51% against the euro over three months and at most 1.02% over a year.
// A rate that is fresh to the minute would therefore change the printed figure by a
// fraction of the width the estimate already admits to, while costing a runtime provider
// that can fail, that needs a failure message on the results card, and that leaves the app
// unable to convert offline. This app is a PWA and shows cached answers first.
//
// The source is the European Central Bank's daily reference rates, read through
// api.frankfurter.dev, which needs no key and no attribution token. The ECB publishes one
// set per working day at about 16:00 CET, so a "daily rate" is the finest grain that
// exists here; there is no intraday number being rounded off.
//
// Output shape: `{ fetchedAt, referenceDate, base, rates }`. Three of those four are
// dates or a denominator and none substitutes for another. `fetchedAt` is when WE asked,
// on our clock. `referenceDate` is the day the ECB says these rates are for, on theirs,
// and it is the older of the two by up to a weekend. `base` is EUR because that is what
// the ECB publishes against; every other pair is crossed through it at read time.
//
// Written as a TypeScript module rather than as JSON, the way prepare-flags.mjs writes
// flag-assets.generated.ts, and NOT the way the four .generated.json datasets in that
// directory are written. Those are only ever read through a dynamic import() under Vite.
// This one is imported statically and synchronously (see exchange-rates.ts on why), so it
// is also loaded by Playwright's config loader, which runs plain Node ESM and rejects a
// JSON import with no `with { type: 'json' }` attribute. Measured: `CI=1 pnpm test:e2e`
// collected zero tests and printed that TypeError four times. A .ts module has no such
// rule and needs no loader flag.
//
// Usage: node scripts/fetch-exchange-rates.mjs

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/exchange-rates.generated.ts', import.meta.url)
);
const API_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR';

/** Every currency the ECB publishes, not only the ones the picker offers today. The
 * fourteen in src/lib/settings/currencies.ts are the ones a traveller can choose from a
 * tile, and keys/storage.ts keeps any well-formed code an imported key file names, so
 * narrowing this to today's picker would silently stop converting for exactly the
 * traveller whose currency the app already treats as valid. Thirty rates is under a
 * kilobyte. */
async function fetchRates() {
	const response = await fetch(API_URL, { headers: { accept: 'application/json' } });
	if (!response.ok) {
		throw new Error(`Frankfurter answered ${response.status} ${response.statusText} for ${API_URL}`);
	}
	const body = await response.json();
	if (typeof body?.date !== 'string' || typeof body?.rates !== 'object' || body.rates === null) {
		throw new Error(`Frankfurter answered without a date and a rates object: ${JSON.stringify(body).slice(0, 300)}`);
	}
	if (body.base !== 'EUR' || body.amount !== 1) {
		throw new Error(`Expected 1 EUR as the base, got amount ${body.amount} of ${body.base}`);
	}
	return { referenceDate: body.date, rates: body.rates };
}

function validate(rates) {
	const entries = Object.entries(rates);
	if (entries.length < 20) {
		throw new Error(`Only ${entries.length} rates came back; the ECB set has about 30, so something is truncated`);
	}
	for (const [code, rate] of entries) {
		if (!/^[A-Z]{3}$/.test(code)) throw new Error(`"${code}" is not an ISO 4217 code`);
		if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
			throw new Error(`Rate for ${code} is ${rate}, which cannot divide an amount`);
		}
	}
}

const { referenceDate, rates } = await fetchRates();
validate(rates);

// Sorted so a diff of this file reads as "which rates moved" rather than as whatever order
// the API happened to serialise, the same reason fetch-cheap-routes.mjs sorts its routes.
// EUR against itself is written explicitly: the ECB does not publish it, and a lookup that
// has to special-case its own base is a lookup that will forget to.
const sorted = Object.fromEntries(
	Object.entries({ EUR: 1, ...rates }).sort(([a], [b]) => a.localeCompare(b))
);

const dataset = {
	fetchedAt: new Date().toISOString(),
	referenceDate,
	base: 'EUR',
	rates: sorted
};

const module = `// Generated by scripts/fetch-exchange-rates.mjs. Do not edit by hand.
//
// European Central Bank daily reference rates, one euro in each currency, read through
// api.frankfurter.dev. Refreshed by .github/workflows/exchange-rates.yml and consumed by
// src/lib/data/exchange-rates.ts, which is the only module that should import this one.
//
// A .ts module rather than JSON because this is imported statically and therefore reaches
// Playwright's plain-Node config loader, which refuses a JSON import without an import
// attribute. See fetch-exchange-rates.mjs for the measurement.

export interface ExchangeRatesFile {
\t/** ISO instant CI read these. Our clock. */
\treadonly fetchedAt: string;
\t/** The day the ECB says these rates are for. Their clock, and the older of the two. */
\treadonly referenceDate: string;
\treadonly base: 'EUR';
\treadonly rates: Readonly<Record<string, number>>;
}

export const EXCHANGE_RATES: ExchangeRatesFile = ${JSON.stringify(dataset, null, '\t').replace(
	/"([^"]*)":/g,
	"$1:"
).replace(/: "([^"]*)"/g, ": '$1'")};
`;

await writeFile(OUTPUT_PATH, module, 'utf-8');
console.log(
	`Wrote ${Object.keys(sorted).length} ECB reference rates for ${referenceDate} to ${OUTPUT_PATH}`
);
