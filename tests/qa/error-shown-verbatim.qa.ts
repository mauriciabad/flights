/**
 * Invariant: when a stay provider fails, the words on the page are the provider's own.
 *
 * AGENTS.md states this as a rule and gives its history: "we should show the actual errors
 * recieved, not invent our own". #237 built it. `providers/response-evidence.ts` quotes the
 * status and the sentence, `stays/no-stays-reason.ts` keeps them in their own field so no
 * caller can paraphrase one into the other, and `ResultDetail.svelte` prints them in the
 * stopover's fold.
 *
 * What #240 found is that nothing checked the last step. `no-stays-reason.test.ts` pins the
 * wording of a pure function, and the only evidence the sentence ever reached a rendered
 * page was one agent's browser session at 05:00. Neither survives somebody refactoring
 * `ResultDetail.svelte`. The orchestrator who tried to confirm it by hand failed seven times
 * in a row, every time for a different correct-behaviour reason:
 *
 * 1. The notice lives in the customise panel, so it exists only for the segment the reader
 *    has picked. Two clicks since issue #278: unfold the trip strip, then pick the
 *    stopover row. (Before it: "Show details", then the row, and the notice unfolded
 *    inside the row itself.)
 * 2. `stayIsRelevant` is `nightsInConnection > 0 || stay !== undefined`, so a same-day
 *    flight change correctly renders no missing-bed notice at all. The first card on the
 *    page is not reliably a card with a night in it.
 * 3. With every stay provider failing, the builder returns different pairings than it does
 *    when beds are priced, so no card can be addressed by position.
 *
 * `openStopoverWithANight` walks those three rather than assuming past them, and prints what
 * it saw on every card when it cannot get there.
 *
 * ## Why this is anchored where it is
 *
 * On `[data-testid="stay-provider-failure"]`, on the status code, and on the exact bytes the
 * route handler put on the wire. Never on a sentence from `src/`. A bed check in this repo
 * once grepped for wording the UI had already changed and passed vacuously for a day
 * (`.audit/check-predicate.sh` carries the note), and a check that asserts our own prose
 * would go green on the very refactor it exists to catch.
 *
 * The fixture marker is what turns "not our own wording" into a fact rather than a hope.
 * `tests/e2e/fixtures/markers.json` exists so a token appears in no airport, city, airline
 * or hotel name and nothing in `src/` renders it, and `tests/e2e/guard.spec.ts` holds that.
 * A sentence carrying it on screen came off the wire or came from nowhere.
 *
 * ## Proved by breaking it
 *
 * Three mutations of `src/`, each caught by the assertion written for it, before this was
 * committed. Deleting the `{#each noStaysNotice.providerFailures}` block fails the "no
 * failure line at all" assertion. Replacing `failureLines` with our own sentence that still
 * names HTTP 503 fails the verbatim one and passes the status one, which is the pair that
 * matters. Dropping the status out of `describeProviderResponse` fails only the status one.
 */

import { expect, test } from './support/bench';
import { HOSTELWORLD_HOST } from './support/catalog';
import { FIXTURE_TEXT_TOKEN } from './support/markers';
import { waitForSearchToSettle } from './support/page';
import { resultsUrl } from './support/scenario';
import type { Locator, Page } from '@playwright/test';

/** What the bench makes Hostelworld answer with. `503` because that is the status the real
 * host was returning on 2026-09-05 when #203 was measured, and the body is Hostelworld's own
 * `{"message":…}` shape (`response-evidence.ts` lists every error shape this repo has met).
 *
 * The sentence carries the fixture marker on purpose. It is a string no part of `src/` can
 * produce, so finding it on screen proves the words travelled from the wire rather than from
 * a template. That is the claim under test, and no amount of prose-matching could establish
 * it. */
const FAILURE_STATUS = 503;
const FAILURE_SENTENCE = `${FIXTURE_TEXT_TOKEN} bed service is unavailable, try again later`;
const FAILURE_BODY = JSON.stringify({ message: FAILURE_SENTENCE });

/** Our own words for a failure that arrived with nothing to quote (`no-stays-reason.ts`).
 * If this is what the page ends up printing, the provider's sentence was lost somewhere
 * between the client and the fold, which is the regression this file exists to catch. */
const OUR_EMPTY_HANDED_WORDING = 'failed without saying why';

interface OpenedStopover {
	/** The customise panel, already showing the stopover this card offers. */
	panel: Locator;
	/** What that row said about its own length, quoted back in a failure message so a reader
	 * can see which card was opened. */
	nightsLine: string;
}

/**
 * Opens a card, opens its stopover row, and hands back the first one whose stopover actually
 * has a night in it.
 *
 * Cards are walked, not indexed. Which pairings the builder returns depends on whether beds
 * could be priced (#240's third point), so "the London card" and "the first card" are both
 * names for something that moves. The question this asks of each card in turn does not.
 */
async function openStopoverWithANight(page: Page): Promise<OpenedStopover> {
	const entries = page.locator('.results-list > li');
	const count = await entries.count();
	const seen: string[] = [];

	for (let index = 0; index < count; index += 1) {
		const entry = entries.nth(index);
		const unfold = entry.locator('.trip-strip-unfold');
		if ((await unfold.count()) === 0) continue;

		await unfold.click();
		const row = entry.locator('[data-segment="free-time"]');
		await expect(row).toBeVisible();

		// "2 nights in Vienna" or "Day stopover in Vienna", from `ItineraryTimeline.svelte`.
		// Read as a night COUNT rather than matched as a phrase: the `<strong>` holds a number
		// only when there is one, which is the same condition `stayIsRelevant` turns on.
		const nightsLine = (await row.locator('.tl-stopover-nights').innerText()).replace(/\s+/g, ' ').trim();
		seen.push(nightsLine);
		const nights = Number(
			await row
				.locator('.tl-stopover-nights strong')
				.first()
				.textContent()
				.catch(() => null)
		);

		if (!Number.isFinite(nights) || nights < 1) {
			await unfold.click();
			continue;
		}

		await row.click();
		const panel = page.getByTestId('segment-customiser');
		await expect(
			panel,
			`Clicking the stopover row on a card reading "${nightsLine}" filled no customise panel. Since issue #278 the page holds one selection and renders SegmentCustomiser for it, as a rail beside the list above 64rem and a sheet below; either the row stopped reporting its selection or the panel stopped mounting, and every assertion below is about what that panel contains.`
		).toBeVisible();
		await expect(
			panel,
			`The customise panel is showing something other than the stopover after clicking the stopover row on "${nightsLine}".`
		).toHaveAttribute('data-segment', 'free-time');
		return { panel, nightsLine };
	}

	throw new Error(
		[
			'No card on the results page has a stopover with a night in it, so the missing-bed notice could not be reached at all.',
			`Stopover rows seen, in order: ${seen.length > 0 ? seen.join(' | ') : '(none: no card had a trip strip to unfold)'}.`,
			'',
			'`stayIsRelevant` in SegmentCustomiser.svelte is `nightsInConnection > 0 || stay !== undefined`, so a page of',
			'same-day flight changes correctly shows no notice anywhere. If that is what happened, the scenario in',
			'tests/qa/support/scenario.ts has stopped producing an overnight pairing. SELLING_DAY_OFFSETS is what',
			'spaces the two legs onto different days.'
		].join('\n')
	);
}

test.describe("a stay provider's failure reaches the page in its own words", () => {
	test.describe('with Hostelworld answering 503', () => {
		test.use({
			benchOptions: {
				failWith: { hostelworld: { status: FAILURE_STATUS, body: FAILURE_BODY } }
			}
		});

		test('the stopover quotes the status and the sentence Hostelworld sent', async ({ page, bench }) => {
			await page.goto(resultsUrl());
			await waitForSearchToSettle(page);

			// Vacuity guard first. Everything below is about what the page does with a failed
			// response, so a run where no request ever reached Hostelworld would assert nothing
			// and say so in the least useful way available.
			const asked = bench.countFor('hostelworld');
			expect(
				asked,
				`Nothing was asked of Hostelworld (${HOSTELWORLD_HOST}) during this search, so no failure could have been rendered and this check proves nothing. Requests this search made:\n${bench.describeTraffic()}`
			).toBeGreaterThan(0);

			const { panel, nightsLine } = await openStopoverWithANight(page);
			const notice = panel.locator('[data-testid="stay-notice"]');
			const failure = notice.locator('[data-testid="stay-provider-failure"]');

			await expect(
				failure,
				`The stopover panel rendered no [data-testid="stay-provider-failure"], on a card whose row reads "${nightsLine}", after ${asked} request(s) to Hostelworld all answered ${FAILURE_STATUS}. describeNoStays() puts a failed provider's message in providerFailures and SegmentCustomiser.svelte renders one <p> per entry; one of those two has stopped happening. What the panel does say:\n\n${await panel.innerText()}`
			).toHaveCount(1);

			const shown = (await failure.innerText()).trim();

			expect(
				shown,
				`The failure line on screen does not carry the status code. The response the app got was ${FAILURE_STATUS}, and "403 versus 200-with-an-error-body is exactly the distinction that went missing" (AGENTS.md). On screen:\n\n${shown}`
			).toContain(String(FAILURE_STATUS));

			expect(
				shown,
				`The failure line does not repeat what Hostelworld actually said. The route handler answered ${FAILURE_STATUS} with body ${FAILURE_BODY}, so the sentence below should appear inside it verbatim:\n\n  sent:  ${FAILURE_SENTENCE}\n  shown: ${shown}\n\nA summarised, translated or re-worded provider message is the defect. See AGENTS.md, "Show the error you got, never the one you assumed".`
			).toContain(FAILURE_SENTENCE);

			// The words are the provider's, not ours. `FIXTURE_TEXT_TOKEN` appears in no name
			// any dataset holds and nothing in `src/` renders it, so a line carrying it can only
			// have come off the wire. That claim is stronger than any prose match, and it is the
			// one that survives the UI being rewritten around it.
			expect(
				shown,
				`The failure line is the app's own wording rather than the provider's: it does not contain "${FIXTURE_TEXT_TOKEN}", which is the marker the route handler's sentence carries and which nothing in src/ can produce (tests/e2e/fixtures/markers.json). On screen:\n\n${shown}`
			).toContain(FIXTURE_TEXT_TOKEN);

			expect(
				shown,
				`The page fell back to "${OUR_EMPTY_HANDED_WORDING}", which no-stays-reason.ts prints only for a provider that failed WITHOUT a message. Hostelworld sent one: ${FAILURE_BODY}. It was dropped between hostelworld-client.ts and the fold.`
			).not.toContain(OUR_EMPTY_HANDED_WORDING);
		});
	});

	/**
	 * The control, and it has to open the same fold to be worth anything. Asserting "no
	 * failure line on the page" without expanding a card would pass on an app that prints one
	 * unconditionally, since the notice only ever renders inside a row a reader has opened.
	 * That is the same shape of vacuous pass `.audit/check-predicate.sh` records.
	 */
	test('the same fold carries no failure line when Hostelworld answers normally', async ({ page, bench }) => {
		await page.goto(resultsUrl());
		await waitForSearchToSettle(page);

		expect(
			bench.countFor('hostelworld'),
			'Hostelworld was never asked, so this control proves nothing'
		).toBeGreaterThan(0);

		const { panel, nightsLine } = await openStopoverWithANight(page);

		// Beds were priced, so the fold is a picker rather than a notice. Asserted rather than
		// assumed: without it, a fold that failed to render at all would pass the check below.
		await expect(
			panel.locator('.stay-picker'),
			`Hostelworld answered normally and the stopover panel on "${nightsLine}" still shows no stay picker, so this control is not looking at a healthy panel. What it does say:\n\n${await panel.innerText()}`
		).toBeVisible();

		await expect(
			panel.locator('[data-testid="stay-provider-failure"]'),
			'The stopover quotes a provider failure while every provider answered. An error shown when nothing went wrong is an invented error, which is the same rule read the other way round.'
		).toHaveCount(0);
	});
});
