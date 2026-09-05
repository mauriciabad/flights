/**
 * Invariant: every offer names the provider that sourced it, and flies a route and a flight
 * number that provider actually offered.
 *
 * docs/ACCEPTANCE.md calls this the highest-severity class in the repo, ahead of every
 * feature: "An empty result disappoints. A fabricated itinerary is a booking the traveller
 * cannot make, discovered at an airport they have already flown to." An agent has already
 * reported verifying "BVC to LGW to PFO, EUR 238, via Ryanair" — two flights that do not
 * exist, on a network that 404s all three airports.
 *
 * The bench is what makes this checkable rather than a matter of judgement. It answers as
 * the provider would: a sellable fare for a leg it flies, a month of `unavailable` rows for
 * one it does not. So every route and flight number the app may legitimately show is
 * knowable from the traffic, and anything on screen that is not in the traffic was invented
 * somewhere between the response and the card.
 *
 * This catches the class, not the incident: it re-derives what was offered from the bodies
 * served during this very run, so it keeps working when the scenario changes, when a
 * provider is added, and when an adapter starts filling a gap with bundled fallback data.
 *
 * ## Both halves have to be read out of the run, and both are easy to get quietly wrong
 *
 * They were, for a day. Issue #137 split Ryanair's answer in two — `cheapestPerDay` carries
 * the price and names neither airport, `timtbl/3/schedules` carries the flight number — and
 * this file was still reading `fares[].outbound.departureAirport` out of an endpoint the
 * adapter had stopped calling. Separately, #183 turned the timeline into a timetable and
 * `.tl-flight` stopped existing, so the flight-number half matched nothing and passed on an
 * empty list. A check that reads the screen or the wire has to fail when what it reads
 * disappears, which is why both halves below assert they found something before they assert
 * anything about it.
 *
 * Opening a card to read its flight numbers is also what found #188: a card with a priced
 * bed threw while rendering and showed no timeline at all. Fixed in #195. The assertion
 * that at least one card showed a flight row is what turned that from a silent pass into a
 * failure somebody could read.
 */

import { test, expect, type Bench } from './support/bench';
import { DESTINATION, ORIGIN, ROUTE_GRAPH, flies, resultsUrl } from './support/scenario';
import { resultCards, waitForSearchToFinish } from './support/page';

/** `cheapestPerDay` echoes back neither airport, so the route is in the request path — the
 * same place `ryanair-mapper.ts` has to take it from. */
const FARE_PATH = /\/farfnd\/v4\/oneWayFares\/([A-Z]{3})\/([A-Z]{3})\/cheapestPerDay$/;
const SCHEDULE_PATH = /\/timtbl\/3\/schedules\/([A-Z]{3})\/([A-Z]{3})\/years\/\d{4}\/months\/\d{1,2}$/;

function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function pathnameOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return '';
	}
}

/**
 * Every `from -> to` pair Ryanair had a seat to sell on in this run, read back out of the
 * bodies rather than out of the scenario file.
 *
 * A month of rows is not an offer: `unavailable` is how the endpoint answers both a day it
 * does not sell and a route it does not fly at all (ryanair-types.ts, measured against the
 * live endpoint), and `soldOut` is a flight whose fare cannot be bought. Counting either as
 * "offered" would widen this check until it could not catch the thing it exists for.
 */
function legsOffered(bench: Bench): Set<string> {
	const legs = new Set<string>();
	for (const body of bench.bodies) {
		if (body.providerId !== 'ryanair') continue;
		const route = FARE_PATH.exec(pathnameOf(body.url));
		if (!route) continue;
		const fares = (parse(body.text) as { outbound?: { fares?: unknown } } | undefined)?.outbound?.fares;
		if (!Array.isArray(fares)) continue;
		const sellable = fares.some((fare) => {
			const row = fare as { unavailable?: unknown; soldOut?: unknown; price?: unknown };
			return row?.unavailable !== true && row?.soldOut !== true && row?.price != null;
		});
		if (sellable) legs.add(`${route[1]}->${route[2]}`);
	}
	return legs;
}

/**
 * Every `<carrier code><number>` the recorded timetables quoted, joined the way
 * `ryanair-mapper.ts` joins them.
 *
 * The timetable is the only place a Ryanair flight's identity comes from — the fare
 * calendar has no number, no carrier and no airports — so this is the whole set of flights
 * the app is entitled to name. The carrier code comes from the feed too, since Ryanair
 * Holdings flies under more than one AOC and the mapper stopped hardcoding "FR".
 */
function flightNumbersOffered(bench: Bench): Set<string> {
	const numbers = new Set<string>();
	for (const body of bench.bodies) {
		if (body.providerId !== 'ryanair') continue;
		if (!SCHEDULE_PATH.test(pathnameOf(body.url))) continue;
		const days = (parse(body.text) as { days?: unknown } | undefined)?.days;
		if (!Array.isArray(days)) continue;
		for (const day of days) {
			const flights = (day as { flights?: unknown })?.flights;
			if (!Array.isArray(flights)) continue;
			for (const flight of flights) {
				const { carrierCode, number } = (flight ?? {}) as { carrierCode?: string; number?: string };
				if (carrierCode && number) numbers.add(`${carrierCode}${number}`);
			}
		}
	}
	return numbers;
}

/**
 * Every flight row a card's expanded timeline shows, as text.
 *
 * `ResultDetail` renders as a SIBLING of the card inside the list item, not inside it, so
 * the timeline is read from the row. Cards are opened one at a time because the page owns a
 * single `expandedId` and opening a second closes the first.
 */
/**
 * Every flight row the full timeline draws for one card, unfolded and folded again.
 *
 * Issue #278 replaced the card's "Show details" button with the trip strip's own stopover
 * caption, and moved the timeline inside the card rather than into a sibling below it, so
 * both the gesture and the ancestor walk changed. The rest of this check is untouched: it
 * still reads `.tl-row-flight` and it still fails loudly on an empty list, which is the
 * assertion that caught this rename rather than passing vacuously over it.
 */
async function flightsShownOn(card: import('@playwright/test').Locator): Promise<string[]> {
	const unfold = card.locator('.trip-strip-unfold').first();
	if ((await unfold.count()) === 0) return [];
	await unfold.click();

	const rows = card.locator('.tl-row-flight');
	await rows.first().waitFor({ state: 'visible', timeout: 15_000 });
	const lines = await rows.allInnerTexts();

	await unfold.click();
	return lines.map((row) => row.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

test.describe('no fabricated flights', () => {
	test('every itinerary names its provider and flies legs that provider offered', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const cards = await resultCards(page).all();
		expect(cards.length, 'nothing was found, so nothing can be checked for fabrication').toBeGreaterThan(0);

		const offered = legsOffered(bench);
		expect(offered.size, 'the bench served no sellable Ryanair fares at all, so this run proves nothing').toBeGreaterThan(0);

		const unsourced: string[] = [];
		const invented: string[] = [];

		for (const card of cards) {
			const text = await card.innerText();

			// Issue #56: every value carries which provider produced it. A card with no
			// provenance footer is an offer nobody can be held to.
			const provenance = await card
				.locator('.provenance')
				.innerText()
				.catch(() => '');
			if (!/via\s+\S/.test(provenance)) {
				unsourced.push(text.split('\n').slice(0, 4).join(' '));
				continue;
			}

			// The route as the card prints it. The trip strip is where the stopover's IATA
			// code lives since #183 moved it off the header, and it prints all three codes on
			// the boundaries they name, in order.
			const codes = (await card.locator('.trip-strip-code').allInnerTexts()).map((code) => code.trim());
			expect(
				codes,
				`A card rendered ${codes.length} airport codes in its trip strip (${codes.join(', ')}), not the three a stopover itinerary has. This check cannot read a route it cannot see.`
			).toHaveLength(3);

			const [from, via, to] = codes;
			for (const leg of [`${from}->${via}`, `${via}->${to}`]) {
				if (!offered.has(leg)) {
					invented.push(`${leg} on a card sourced "${provenance.replace(/\s+/g, ' ').trim()}"`);
				}
			}
		}

		expect(
			unsourced,
			`${unsourced.length} itinerary(s) render with no "via <provider>" footer: ${unsourced.join(' | ')}. An offer that cannot name where it came from cannot be checked against the provider that supposedly sells it.`
		).toEqual([]);

		expect(
			invented,
			[
				`${invented.length} leg(s) appear on screen that no provider offered in this run:`,
				...invented.map((line) => `  - ${line}`),
				'',
				'Legs the providers actually had a sellable fare on:',
				`  ${[...offered].sort().join(', ')}`,
				'',
				'docs/ACCEPTANCE.md: an offer whose airline the sourcing provider does not fly is',
				'the highest-severity bug in the repo, ahead of every feature.'
			].join('\n')
		).toEqual([]);
	});

	test('every flight number on screen came out of a timetable', async ({ page, bench, withKeys }) => {
		await withKeys();
		await page.goto(resultsUrl());
		await waitForSearchToFinish(page);

		const cards = await resultCards(page).all();
		expect(cards.length, 'nothing was found, so nothing can be checked for fabrication').toBeGreaterThan(0);

		const offeredNumbers = flightNumbersOffered(bench);
		expect(
			offeredNumbers.size,
			'no recorded timetable was served, so every flight number on screen would pass this vacuously'
		).toBeGreaterThan(0);

		const shownFlights: string[] = [];
		for (const card of cards) shownFlights.push(...(await flightsShownOn(card)));

		expect(
			shownFlights.length,
			`${cards.length} itinerary(s) were opened and not one showed a flight row. Either the timeline stopped rendering flights or the selector this check reads them with has gone stale — both leave the check below passing on an empty list, which is how this half of the invariant went quiet after #183.`
		).toBeGreaterThan(0);

		const untraceable = shownFlights.filter((line) => ![...offeredNumbers].some((number) => line.includes(number)));
		expect(
			untraceable,
			[
				`${untraceable.length} flight(s) are shown that no provider quoted in this run:`,
				...untraceable.map((line) => `  - ${line}`),
				'',
				`Flight numbers the providers actually quoted: ${[...offeredNumbers].sort().join(', ') || '(none)'}`,
				'',
				"A flight number is a Ryanair offer's whole identity, and the only place it comes",
				'from is the timetable feed — the fare calendar carries no number, no carrier and',
				'no airports. A number on screen that is in no timetable was invented between the',
				'response and the card.'
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

		const offered = legsOffered(bench);
		expect(
			[...offered].filter((leg) => leg === `${ORIGIN}->${DESTINATION}`),
			`The bench offered a ${ORIGIN}->${DESTINATION} fare it should never have offered. The route graph in tests/qa/support/scenario.ts says otherwise: ${JSON.stringify(ROUTE_GRAPH[ORIGIN])}.`
		).toEqual([]);
	});
});
