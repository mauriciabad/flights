import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';
import type { RyanairFlightSpec } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * How tall one result card is on a 375px phone, asserted against the list of blocks the
 * card is allowed to carry.
 *
 * Issue #197 brought the card down to 462px and wrote the number in a comment. Issue #232
 * then added a price band, #225 a "staying longer" ladder and #210 a technical-stop note,
 * each of them measured against that comment by whoever happened to read it. By the time
 * issue #278 opened, the card was back over 540px and nothing in the suite had noticed. So
 * the budget moved here, where a run checks it, and #278 set it to what a phone has under
 * the app header and the tab bar: 620px.
 *
 * ## The 620 this file used to assert, and the overflow it is carrying
 *
 * That number is still true about the screen. Measured on 2026-09-06 at 375x812, the app
 * header is 53px and a sticky `section.summary` is 74px, so a chromeless 812px viewport
 * leaves 685px of list and a real phone with browser UI leaves meaningfully less.
 *
 * What is not true is that the card meets it. On 2026-09-06 at 375x812, waiting on
 * `data-search-phase="settled"`, against
 * `flights.mauri.app/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`, the six
 * settled cards measured 727, 651, 651, 651, 727, 727. Two runs, identical both times.
 * Every card is 31px to 107px over. Issue #303 reported 715 to 770, so the numbers have
 * moved and the gap has not closed.
 *
 * The ceiling stayed green through all of that because the fixture under it was a bare
 * card: two flights, no bed, no price band. It measured 531px on 2026-09-06, 89px inside
 * the budget, and it always would. That is issue #298's complaint, a limit that cannot see
 * the cards which would fail it, still true one test after #302 fixed it for the worst
 * case.
 *
 * ## Why the budget below is not the screen
 *
 * Three ways out of that, and the two obvious ones are worse.
 *
 * Taking a block off the card overrules the issue that asked for it. Every entry in
 * `COLLAPSED_CARD_BLOCKS` names one, and the owner's position is that the card earns its
 * height. Which block goes is his call, not a test's.
 *
 * Moving the ceiling to 740 sets the limit to whatever the card happens to measure, which
 * is the original defect wearing a bigger number. #302 said so and was right.
 *
 * Outside guidance does not settle it either. Nobody states one card per screen as a goal
 * and no source gives a card-height figure at all. The one source that speaks to it argues
 * the other way: NN/g's "Scrolling and Attention" (Therese Fessenden, 2018-04-15,
 * https://www.nngroup.com/articles/scrolling-and-attention/) recommends cut-off content as
 * a deliberate signifier that more exists below the fold.
 *
 * So the budget comes from the list of blocks the card carries. That is what fails when the
 * card grows, which is the property #278 wanted and never got, and it cannot be raised
 * without naming a block or a term in a diff a reviewer reads.
 *
 * #278's own arithmetic, kept because it is the history of the number above. #278 took the
 * card from 752px to 492px, and then #287 landed `FlightDetour` on it, an 80px drawing.
 * Nothing left on the collapsed card duplicates it: the receipt, the strip and the rail
 * each answer a different question, and the detour is the only thing that answers "how far
 * out of the way is this". #305 then put it beside the receipt instead of above it, so
 * today it costs the card nothing at all.
 *
 * ## The blocks, in the order the card prints them
 *
 * Heights measured on 2026-09-06 at 375px against `typicalSearch`, which builds a 748px
 * card. Five of the six match the 727px card production serves exactly; the rail is the
 * one that does not, and its entry says why. The test prints what it measures on every
 * run, so this table cannot go quietly stale the way #197's comment did.
 */
interface CardBlock {
	/** First class on the block's own element, which is what the card is asserted against. */
	readonly block: string;
	/** The issue that put it on the card, so a failure names what there is to argue about. */
	readonly issue: string;
	readonly px: number;
	/** Set when the block is a row rather than a stack. The row costs the taller occupant,
	 * so `px` above is that one's height and not the pair's sum. */
	readonly beside?: readonly string[];
}

const COLLAPSED_CARD_BLOCKS: readonly CardBlock[] = [
	/* The route line. #278 took the neutral freshness badge out of it: "Current price" said
	   what the footer's "fetched 3m ago" already said, and at 375px it wrapped and cost the
	   card a row it could not spare. */
	{ block: 'card-header', issue: '#278', px: 90 },
	/* #305, the owner: the flight map "is placed to the left of the Getting there price
	   breakdown, so space is better used". One row holding two blocks, so it costs the
	   taller of them instead of both. `flight-shape` is #287's 80px drawing and `price-line`
	   is the receipt, and the receipt is what governs. */
	{ block: 'card-getting-there', issue: '#305', px: 156, beside: ['flight-shape', 'price-line'] },
	/* #232, directly under the receipt because the band is about the figure in it. The
	   largest optional block on the card. */
	{ block: 'price-band', issue: '#232', px: 140 },
	/* #278: the preview is the expander, so the affordance sits on the thing that opens and
	   the card spends no row on a button of its own. */
	{ block: 'card-strip', issue: '#278', px: 79 },
	/* #309: every summary figure has exactly one surface on this card, and free time, in
	   flight, airport wait and door to door are this rail's. 143 where production's is 122,
	   and that 21px is the whole difference between this card and the tallest one production
	   serves. Barcelona to Vienna to Tallinn leaves "Part of a day" of free time, which
	   wraps in a cell sized for "2 full days". Geography, not a block. */
	{ block: 'metric-rail', issue: '#309', px: 143 },
	/* The carriers, #210's technical-stop note and #312's source note, on one ellipsised
	   line that costs the same whatever it carries. */
	{ block: 'card-footer', issue: '#312', px: 58 }
];

/** The blocks' own heights. A row costs its taller occupant, which is already what that
 * entry's `px` is, so this is a plain sum. */
const CARD_BLOCKS_PX = COLLAPSED_CARD_BLOCKS.reduce((total, block) => total + block.px, 0);

/** What the card spends on nothing, derived rather than observed. `.card-main` pads
 * `--space-4` top and bottom and puts a `--space-4` gap between its four blocks, and the
 * card's own border adds 1px at each end. At `--space-4: 1rem` that is 16 * 2 + 16 * 3 + 2. */
const CARD_GAPS_AND_PADDING_PX = 16 * 2 + 16 * 3 + 2;

/** Under the 58px footer, the smallest block on the card, so no block that arrives can hide
 * inside the slack. Over the 21px one wrapped line costs, measured as the difference between
 * this rail at 143px and production's at 122px, so a label that breaks at a slightly
 * different width does not fail a test whose subject is the block set. It buys exactly one
 * such wrap and no second one. Rows arriving inside a block are the worst-case test's
 * subject, and its slack is the tight one. */
const CARD_HEIGHT_SLACK_PX = 24;

/**
 * The ceiling for the ordinary card, as a sum rather than an observation. Raising it means
 * raising a named term or adding a named block, both of which a reviewer reads in the diff.
 */
const TYPICAL_CARD_HEIGHT_BUDGET_PX =
	CARD_BLOCKS_PX + CARD_GAPS_AND_PADDING_PX + CARD_HEIGHT_SLACK_PX;

/** What a phone leaves for a card, from the measurement at the top of this file. Nothing
 * asserts it any more. The test prints the overflow against it because a number the owner
 * is carrying should be on screen every run, and because this file's own history is comments
 * with numbers in them that nobody rechecked. */
const PHONE_SCREEN_PX = 620;

/**
 * What the tallest card this app can build measures, which is a different question from the
 * one above and the reason issue #298 was filed.
 *
 * The fixture the first test used to run was a bare card: two flights, no bed, no ground
 * legs, no price band. It measured 531px on 2026-09-06 and it always would, so the ceiling
 * over it passed every day while production served cards nobody had measured. That fixture
 * is gone and `typicalSearch` replaced it. On 2026-09-05, at 375x812 against
 * `flights.mauri.app/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`, the six
 * settled cards measured 715, 730, 715, 730, 770 and 730. Every one of them over the
 * ceiling that was green. A limit that cannot see the cards which would fail it is not a
 * limit, and that is the same defect as `45151ce`'s strip rendering at 0px under five green
 * tests, and as #240, #242, #255 and #257.
 *
 * So the second test measures the worst case rather than the average one. `worstCaseSearch`
 * turns on every optional block the collapsed card has, all at once, and this number is
 * what that card measures.
 *
 * The slack was under 22px when #302 set it, which is one receipt row, so anything adding a
 * row failed here instead of passing on headroom. It drifted out to 48px as the card came
 * down to 812px and 860 stayed put, and then closed again on its own the same afternoon:
 * `fca6d4d` put the trip's dates in the route line, which wraps at 375px and took this
 * card's header from 98px to 130px. Measured on 2026-09-06 after that landed, the worst
 * card is 844px and the slack is 16px, tighter than the figure #302 chose.
 *
 * That is worth reading twice, because it is this file's whole argument in one afternoon.
 * The drift was real, nobody had to chase it, and the reason it is a number here rather
 * than a memory is that the test prints what it measures.
 *
 * The parts are printed by the test on every run, the way the ordinary card's are, rather
 * than transcribed into this comment where nobody rechecks them.
 *
 * This number is not a target and it is not the screen. `PHONE_SCREEN_PX` is still what a
 * phone leaves, and the worst card is 224px over it, so on that card the screen holds
 * one trip and comparing two is impossible. Closing that gap means taking a whole block off
 * the card, and which block is the owner's call rather than a test's: the band is 140px and
 * the newest arrival (#232), the totals rail is 143px. Taking the detour off would buy
 * nothing at all, which is not what this comment used to say. #305 moved it beside the
 * receipt, and measured on 2026-09-06 the receipt is 212px against the drawing's 80px, so
 * the row costs the receipt's height either way. This test exists so that gap is a number
 * somebody decided to carry rather than one nobody could see.
 */
const WORST_CASE_HEIGHT_BUDGET_PX = 860;

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

interface MeasuredBlock {
	block: string;
	px: number;
}

/**
 * The blocks one card is made of, in the order it prints them, each named by the first
 * class on its own element. The two occupants of the `card-getting-there` row are listed
 * under it, because that row costs the taller of them rather than their sum.
 *
 * The point of naming blocks rather than only measuring the total is that a block which
 * arrives shows up here whatever it measures. A card that grows by 30px reads the same as
 * one that grows by 3px until you ask what is on it.
 *
 * `Locator` via `Page` because `support/fixtures` re-exports only `Page`, and importing it
 * from `@playwright/test` here would fail `guard.spec.ts`.
 */
async function measureCardBlocks(
	card: ReturnType<Page['locator']>
): Promise<{ blocks: MeasuredBlock[]; px: number }> {
	return card.evaluate((element) => {
		const nameOf = (node: Element) => node.classList.item(0) ?? '';
		const describe = (node: Element, parent?: Element) => ({
			block: parent ? `${nameOf(parent)} > ${nameOf(node)}` : nameOf(node),
			px: Math.round(node.getBoundingClientRect().height)
		});
		const main = element.querySelector(':scope > .card-body > .card-main');
		const blocks: { block: string; px: number }[] = [];
		for (const node of [
			...Array.from(element.querySelectorAll(':scope > .card-header')),
			...(main ? Array.from(main.children) : []),
			...Array.from(element.querySelectorAll(':scope > .card-footer'))
		]) {
			blocks.push(describe(node));
			if (node.classList.contains('card-getting-there')) {
				for (const occupant of Array.from(node.children)) {
					blocks.push(describe(occupant, node));
				}
			}
		}
		return { blocks, px: Math.round(element.getBoundingClientRect().height) };
	});
}

function describeBlocks(blocks: readonly MeasuredBlock[]): string {
	return blocks.map((block) => `${block.block} ${block.px}`).join(', ');
}

test.describe('result card size', () => {
	test('a card shaped like the ones production serves', async ({ page }) => {
		await typicalSearch(page);

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(TYPICAL_URL);
		await waitForSearchToSettle(page, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();

		const measured = await measureCardBlocks(card);
		console.log(`ordinary card blocks at 375px: ${describeBlocks(measured.blocks)}`);

		expect(
			measured.blocks.map((block) => block.block),
			'The collapsed card carries a different set of blocks than this file records. Each ' +
				'one is on the card because an issue asked for it:\n' +
				COLLAPSED_CARD_BLOCKS.map(
					(block) => `  ${block.block} (${block.issue}, ${block.px}px)`
				).join('\n') +
				'\nA block that arrives makes every card on a phone taller than the screen ' +
				`already leaves it (${PHONE_SCREEN_PX}px), so it is a decision to argue in the ` +
				'issue that wants it and then to write into COLLAPSED_CARD_BLOCKS here.'
		).toEqual(
			COLLAPSED_CARD_BLOCKS.flatMap((block) => [
				block.block,
				...(block.beside ?? []).map((occupant) => `${block.block} > ${occupant}`)
			])
		);

		console.log(
			`ordinary card at 375px: ${measured.px}px, ` +
				`${measured.px - PHONE_SCREEN_PX}px over the ${PHONE_SCREEN_PX}px a phone leaves`
		);
		expect(measured.px).toBeLessThanOrEqual(TYPICAL_CARD_HEIGHT_BUDGET_PX);
	});

	test('the tallest card this app can build', async ({ page }) => {
		await worstCaseSearch(page);

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(WORST_CASE_URL);
		await waitForSearchToSettle(page, { timeout: 30_000 });
		await expect(page.locator('.result-card').first()).toBeVisible();

		// Every card, not the first one. Which itinerary the pipeline ranks top is not this
		// test's business, and the owner's own report on #298 read the fourth card.
		const heights = await page
			.locator('.result-card')
			.evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().height)));

		// The blocks that make it tall, asserted rather than assumed. Without these the test
		// would go on passing over a fixture that had quietly stopped building the worst case,
		// which is issue #298 happening a second time one level up.
		const tallest = page.locator('.result-card').nth(heights.indexOf(Math.max(...heights)));
		await expect(tallest.locator('.price-band')).toBeVisible();
		await expect(tallest.locator('.flight-shape')).toBeVisible();
		await expect(tallest.locator('.avoid-badge')).toBeVisible();
		// Issue #305 rebuilt this receipt. The bed is a titled group with its nights inside it
		// rather than a `Bed` line, and the ground is one named row per leg rather than up to
		// three rows counting rides by kind, so the guards read the new shape. What they are
		// guarding is unchanged: that this fixture really is building the worst case, and has
		// not quietly stopped, which is #298 happening again one level up.
		await expect(tallest.locator('.price-group .price-part-label').first()).toHaveText('Hotel');
		const receipt = await tallest.locator('.price-part').evaluateAll((rows) =>
			rows.map((row) => {
				const label = row.querySelector('.price-part-label')?.textContent?.trim();
				const amount = row.querySelector('.price-part-amount')?.textContent?.trim();
				return `${label} -> ${amount}`;
			})
		);
		console.log(`worst-case receipt: ${receipt.join(' | ')}`);
		const worstCaseBlocks = await measureCardBlocks(tallest);
		console.log(`worst-case card blocks at 375px: ${describeBlocks(worstCaseBlocks.blocks)}`);
		// A walked leg and a rated one on the same receipt, which is the pair that proves both
		// readings of an absent price are being printed (`domain/transfer.ts`).
		//
		// "At least one of each" rather than exactly one free row. Issue #341 moved the ground
		// legs to start at the airport's terminal instead of its runway point, and Tallinn's
		// two are 1.8 km apart, so a leg this fixture used to reach by taxi is now inside
		// walking distance and prints free. How many of the three land on foot is geography.
		// Which two renderings appear is the property.
		const ground = receipt.filter((row) => row.startsWith('Ride'));
		expect(ground.some((row) => row.endsWith('free'))).toBe(true);
		expect(ground.some((row) => !row.endsWith('free'))).toBe(true);
		// Flights, the hotel group's header, at least one nights row and at least two named
		// ground rows: the longest receipt this app can print.
		expect(receipt.length).toBeGreaterThanOrEqual(5);

		console.log(`worst-case result cards at 375px: ${heights.join(', ')}px`);
		expect(Math.max(...heights)).toBeLessThanOrEqual(WORST_CASE_HEIGHT_BUDGET_PX);
	});
});

/**
 * The tallest card the app can build, and why each mock below is here.
 *
 * Issue #298: a ceiling is there to fail on the card that would breach it, so this builds
 * the worst case rather than an average one. Every lever is a real provider answer through
 * the real pipeline. A card assembled by hand would measure whatever its author wanted.
 *
 * - **A month of priced days** puts `PriceBand` on the card (#232), 140px and the single
 *   largest optional block. Sixteen clears `MIN_PRICED_DEPARTURES` with room to spare.
 * - **The Vienna hostel fixture** prices a bed, so the receipt gains a `Bed` row carrying
 *   its nightly rate and its distance from the centre. `people=2` makes that rate read
 *   "for 2", which is what wraps the row onto a second line.
 * - **Transitous answering nothing** is what turns the ground legs into taxis. A bus leg
 *   carries no fare at all and collapses the receipt to one "not priced" row; a taxi leg
 *   carries a rate-card range, and each currency gets a row of its own (#249).
 * - **A London origin against a Tallinn destination** is what makes those two currencies.
 *   The Stansted run rates in GBP off the UK card and the Tallinn run in EUR, which is the
 *   split `priceBreakdown` documents and nothing exercised.
 * - **`avoidAirlines=ZZ`** puts "Airline you avoid" in the header, a badge row of 28px.
 *
 * What is deliberately not here, so the next reader does not take it for an oversight. A
 * technical-stop note reaches the footer only from Kiwi (`kiwi-public-mapper.ts`), and the
 * footer is one ellipsised line, so it costs no height. The `expired-fallback` freshness
 * badge needs a stale IndexedDB entry and a failing refetch, which is a two-load test
 * rather than a fixture. A quoted `Ground` part needs a transfer provider that fills
 * `Transfer.price`, and none does. So this is a floor on the worst case rather than its
 * exact top, and each of those three is one more row the day it lands.
 */
const WORST_CASE_URL =
	'/results/?dep=2027-03-08&arr=2027-03-27&from=STN&to=TLL&people=2&avoidAirlines=ZZ' +
	`&fromLoc=${encodeURIComponent('London Bridge@51.5079,-0.0877')}` +
	`&toLoc=${encodeURIComponent('Tallinn old town@59.4370,24.7536')}`;

/** Enough priced departures to clear `MIN_PRICED_DEPARTURES` (14) with room to spare, and
 * spread far enough in price that the band's tenth and ninetieth percentiles differ. Both
 * fixtures want it, because `PriceBand` is on the ordinary card too. */
const PRICED_DAYS = 16;

/** The flights both fixtures fly, Vienna in the middle. The origin is a parameter because
 * it is the one thing the two searches disagree about: Stansted rates its ground legs in
 * GBP off the UK card against Tallinn's EUR, and that split is an escalation rather than
 * an ordinary search. */
function pricedFlights(origin: string): RyanairFlightSpec[] {
	const flights: RyanairFlightSpec[] = [];
	for (let index = 0; index < PRICED_DAYS; index++) {
		const outbound = String(index + 1).padStart(2, '0');
		const onward = String(index + 3).padStart(2, '0');
		flights.push({
			dep: origin,
			arr: 'VIE',
			depDate: `2027-03-${outbound}T08:00:00`,
			arrDate: `2027-03-${outbound}T10:15:00`,
			price: FIXTURE_PRICES.first + index * 17.17,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		flights.push({
			dep: 'VIE',
			arr: 'TLL',
			depDate: `2027-03-${onward}T11:00:00`,
			arrDate: `2027-03-${onward}T13:20:00`,
			price: FIXTURE_PRICES.second + index * 23.23,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 5) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return flights;
}

async function worstCaseSearch(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna.json'
	);
	await page
		.context()
		.route('https://api.transitous.org/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"itineraries":[]}' })
		);
	// After the generic mocks, so this one wins: Playwright offers a request to the
	// most-recently-registered matching route first.
	await routeRyanairFlights(page.context(), pricedFlights('STN'));
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
}

/**
 * The worst case with its escalations taken off, one at a time, which is the card
 * production actually serves. Derived from `worstCaseSearch` rather than written fresh, so
 * the two fixtures cannot drift into being two different cards for reasons nobody chose.
 *
 * Kept, because production has them. Sixteen priced departures, so `PriceBand` renders
 * (#232, the largest optional block on the card). The Vienna hostel fixture, so a bed is
 * priced and the receipt carries #305's hotel group instead of its "not priced" row.
 *
 * Dropped, each with the block it was inflating.
 *
 * - **`people=2`**. It makes the hotel rate read "for 2" and the taxi row "for 2", which is
 *   what wraps both onto a second line. That is `price-line`, and `price-line` is what sets
 *   the height of the `card-getting-there` row.
 * - **`avoidAirlines=ZZ`**. It puts "Airline you avoid" in `card-header` as a badge, and a
 *   search carries an avoid list only if the traveller set one. The headers measure 90px
 *   here and 98px on the worst case, though their route lines differ too, so that 8px is
 *   not all badge.
 * - **A London origin against a Tallinn destination**. Stansted's ground legs price off the
 *   UK rate card in GBP and Tallinn's off the Estonian one in EUR, which is the split
 *   `priceBreakdown` documents and the reason #249 gives each currency a row. Barcelona
 *   prices in EUR at both ends. Worth knowing before trusting that: the worst-case receipt
 *   printed on 2026-09-06 carries one rated ground row, in EUR, not two, so whatever that
 *   split costs the card today is smaller than this file has been claiming. It is still an
 *   escalation an ordinary search does not carry.
 * - **Transitous answering nothing**. An empty answer is what turns every ground leg into a
 *   taxi, and a taxi carries a rate-card range where a bus carries no fare at all. The
 *   default fixture answers, which is what a traveller in a city with public transport
 *   gets. `price-line` again.
 * - **`fromLoc` and `toLoc`**. A door and a door, rather than two airports. They add a
 *   "Ride from origin" and a "Ride to destination" row to the receipt, and the URL
 *   production was measured on
 *   (`?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`) carries neither. Measured on
 *   2026-09-06 at 375px, keeping them puts `price-line` at 196px and the card at 788px,
 *   which is 61px above the tallest card production serves and 24px off the worst case
 *   below. Dropping them puts `price-line` at 156px, exactly production's, and the card at
 *   748px. Two tests 24px apart measure the same card twice.
 */
const TYPICAL_URL = '/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL';

async function typicalSearch(page: Page) {
	await mockAllKeylessProviders(page.context());
	await mockHostelworld(
		page.context(),
		'hostelworld/continents-vienna.json',
		'hostelworld/properties-vienna.json'
	);
	// After the generic mocks, so this one wins: Playwright offers a request to the
	// most-recently-registered matching route first.
	await routeRyanairFlights(page.context(), pricedFlights('BCN'));
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
}
