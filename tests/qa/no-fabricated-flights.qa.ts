/**
 * Invariant: every offer names the provider that sourced it, and flies a route and an
 * airline that provider actually offered.
 *
 * docs/ACCEPTANCE.md calls this the highest-severity class in the repo, ahead of every
 * feature: "An empty result disappoints. A fabricated itinerary is a booking the traveller
 * cannot make, discovered at an airport they have already flown to." An agent has already
 * reported verifying "BVC to LGW to PFO, EUR 238, via Ryanair" — two flights that do not
 * exist, on a network that 404s all three airports.
 *
 * The bench is what makes this checkable rather than a matter of judgement. It answers as
 * the provider would: fares for a leg it flies, an empty list for one it does not. So every
 * route and airline the app may legitimately show is knowable from the traffic, and anything
 * on screen that is not in the traffic was invented somewhere between the response and the
 * card.
 *
 * This catches the class, not the incident: it re-derives what was offered from the bodies
 * served during this very run, so it keeps working when the scenario changes, when a
 * provider is added, and when an adapter starts filling a gap with bundled fallback data.
 */

import { test, expect } from './support/bench';
import { DESTINATION, ORIGIN, ROUTE_GRAPH, flies, resultsUrl } from './support/scenario';
import { resultCards, waitForSearchToFinish } from './support/page';

/** Every `from -> to` pair the recorded Ryanair responses actually carried a fare for,
 * read back out of the bodies rather than out of the scenario file. */
function legsOfferedIn(bodies: string[]): Set<string> {
	const legs = new Set<string>();
	for (const body of bodies) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		const fares = (parsed as { fares?: unknown }).fares;
		if (!Array.isArray(fares)) continue;
		for (const fare of fares) {
			const outbound = (fare as { outbound?: Record<string, { iataCode?: string }> }).outbound;
			const from = outbound?.departureAirport?.iataCode;
			const to = outbound?.arrivalAirport?.iataCode;
			if (from && to) legs.add(`${from}->${to}`);
		}
	}
	return legs;
}

/** Every flight number the recorded responses actually quoted a fare under. This is the one
 * field on a rendered flight that comes straight from the provider's own body — the carrier
 * beside it is `ryanair-mapper.ts`'s hardcoded `RYANAIR_CARRIER`, so it says which adapter
 * built the offer and nothing about whether the flight exists. */
function flightNumbersOfferedIn(bodies: string[]): Set<string> {
	const numbers = new Set<string>();
	for (const body of bodies) {
		for (const [, number] of body.matchAll(/"flightNumber"\s*:\s*"([^"]+)"/g)) numbers.add(number);
	}
	return numbers;
}

/** Every `<carrier> <flight number>` a card's expanded timeline shows. */
async function flightsShownOn(card: import('@playwright/test').Locator): Promise<string[]> {
	const toggle = card.getByRole('button', { name: /details/i }).first();
	if ((await toggle.count()) === 0) return [];
	await toggle.click();
	const rows = await card.locator('.tl-flight, .tl-detail').allInnerTexts();
	return rows.map((row) => row.trim()).filter(Boolean);
}

test.describe('no fabricated flights', () => {
	test('every itinerary names its provider and flies legs that provider offered', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const cards = await resultCards(page).all();
		expect(cards.length, 'nothing was found, so nothing can be checked for fabrication').toBeGreaterThan(0);

		const offered = legsOfferedIn(bench.bodiesFor('ryanair'));
		expect(offered.size, 'the bench served no Ryanair fares at all, so this run proves nothing').toBeGreaterThan(0);

		const unsourced: string[] = [];
		const invented: string[] = [];

		for (const card of cards) {
			const text = await card.innerText();
			const stopover = (await card.locator('.iata').allInnerTexts()).map((code) => code.trim());

			// Issue #56: every value carries which provider produced it. A card with no
			// provenance footer is an offer nobody can be held to.
			const provenance = await card.locator('.provenance').innerText().catch(() => '');
			if (!/via\s+\S/.test(provenance)) {
				unsourced.push(text.split('\n').slice(0, 4).join(' '));
				continue;
			}

			// The route on the card, read the way it is displayed: origin, stopover, destination.
			const [from, via, to] = stopover;
			for (const leg of [`${from}->${via}`, `${via}->${to}`]) {
				if (!offered.has(leg)) {
					invented.push(`${leg} on a card sourced "${provenance.trim()}"`);
				}
			}
		}

		expect(
			unsourced,
			`${unsourced.length} itinerary(s) render with no "via <provider>" footer: ${unsourced.join(' | ')}. An offer that cannot name where it came from cannot be checked against the provider that supposedly sells it.`
		).toEqual([]);

		// The sharpest form of the same question, and the one docs/ACCEPTANCE.md's own example
		// turns on: a flight number is the single field on a rendered flight that comes
		// straight out of the provider's body, so every one on screen must be in one.
		const offeredNumbers = flightNumbersOfferedIn(bench.bodiesFor('ryanair'));
		const shownFlights = (await Promise.all(cards.map((card) => flightsShownOn(card)))).flat();
		const untraceableFlights = shownFlights.filter(
			(line) => ![...offeredNumbers].some((number) => line.includes(number))
		);
		expect(
			untraceableFlights,
			[
				`${untraceableFlights.length} flight(s) are shown that no provider quoted in this run:`,
				...untraceableFlights.map((line) => `  - ${line}`),
				'',
				`Flight numbers the providers actually quoted: ${[...offeredNumbers].sort().join(', ') || '(none)'}`,
				'',
				'A flight number is the one field on a rendered flight that comes straight from the',
				'provider. The carrier beside it is ryanair-mapper.ts RYANAIR_CARRIER, a constant,',
				'so it names the adapter that built the offer and nothing about whether the flight',
				'exists.'
			].join('\n')
		).toEqual([]);

		expect(
			invented,
			[
				`${invented.length} leg(s) appear on screen that no provider offered in this run:`,
				...invented.map((line) => `  - ${line}`),
				'',
				'Legs the providers actually returned:',
				`  ${[...offered].sort().join(', ')}`,
				'',
				'docs/ACCEPTANCE.md: an offer whose airline the sourcing provider does not fly is',
				'the highest-severity bug in the repo, ahead of every feature.'
			].join('\n')
		).toEqual([]);
	});

	test('a route the provider does not fly produces no offer for it', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		// The scenario's whole premise: the origin has no direct route to the destination.
		// If one shows up anyway, something invented it — which is exactly the shape of the
		// BVC-to-LGW-to-PFO report docs/ACCEPTANCE.md records.
		expect(
			flies(ORIGIN, DESTINATION),
			'the scenario itself now has a direct route, so this check proves nothing — pick a pair that has none'
		).toBe(false);

		const offered = legsOfferedIn(bench.bodiesFor('ryanair'));
		expect(
			[...offered].filter((leg) => leg === `${ORIGIN}->${DESTINATION}`),
			`The bench offered a ${ORIGIN}->${DESTINATION} fare it should never have offered. The route graph in tests/qa/support/scenario.ts says otherwise: ${JSON.stringify(ROUTE_GRAPH[ORIGIN])}.`
		).toEqual([]);
	});
});
