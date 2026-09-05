import { test, expect } from './support/fixtures';
import type { Page } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';
import { waitForSearchToSettle } from '../shared/search-wait';

/**
 * The wait every results-page spec is built on, tested rather than trusted. Issue #337.
 *
 * Thirty-one spec files and the whole QA suite start measuring at whatever this returns, so
 * a wait that returns early is not one bug, it is a mid-flight page underneath every
 * assertion in both suites that does not happen to auto-retry.
 *
 * The two checks below are the two ways a wait for "the search finished" can be wrong, and
 * the old `expect(getByText('still searching')).toHaveCount(0)` failed the first one nine
 * runs in ten: it returned in under 40ms, with nothing on screen, about 3.8 seconds before
 * the first card existed.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

function flights() {
	const specs = [];
	for (let index = 0; index < 6; index++) {
		const day = String(index + 8).padStart(2, '0');
		specs.push({
			dep: 'BCN',
			arr: index % 2 === 0 ? 'VIE' : 'BGY',
			depDate: `2027-03-${day}T08:00:00`,
			arrDate: `2027-03-${day}T10:15:00`,
			price: FIXTURE_PRICES.first + index * 11.11,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[index % FIXTURE_FLIGHT_NUMBERS.length]
		});
		specs.push({
			dep: index % 2 === 0 ? 'VIE' : 'BGY',
			arr: 'TLL',
			depDate: `2027-03-${String(index + 11).padStart(2, '0')}T11:00:00`,
			arrDate: `2027-03-${String(index + 11).padStart(2, '0')}T13:20:00`,
			price: FIXTURE_PRICES.second + index * 13.13,
			flightNumber: FIXTURE_FLIGHT_NUMBERS[(index + 3) % FIXTURE_FLIGHT_NUMBERS.length]
		});
	}
	return specs;
}

async function mockASearchThatFinds(page: Page) {
	await mockAllKeylessProviders(page.context());
	await routeRyanairFlights(page.context(), flights());
	await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
	);
}

test.describe('waiting for a search to settle (issue #337)', () => {
	test('there is something on screen the instant the wait returns', async ({ page }) => {
		await mockASearchThatFinds(page);
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');

		await waitForSearchToSettle(page, { timeout: 20_000 });

		// `count()` deliberately, not `expect(locator).toHaveCount()`. Playwright's retrying
		// assertions are what hid this: the line after the wait quietly covered the hole with
		// its own timeout, so the suite stayed green while measuring an unfinished page. This
		// reads the DOM once, which is what a bounding box or a request tally does.
		const cards = await page.locator('.result-card').count();
		expect(cards, 'cards on screen when the wait returned').toBeGreaterThan(0);
	});

	test('the wait does not return while the search is still running', async ({ page }) => {
		await mockASearchThatFinds(page);
		// Registered last, so Playwright reaches it before the fixtures above: the fare
		// endpoint never answers, the search never yields a snapshot carrying `done`, and a
		// wait with any state in it has to time out. The old one returned in milliseconds,
		// because the page has not put "still searching" on screen yet either.
		await page.context().route('**/oneWayFares/**', () => {});
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');

		const phase = page.locator('[data-search-phase]');
		await expect(phase).toHaveAttribute('data-search-phase', 'searching', { timeout: 10_000 });
		await expect(waitForSearchToSettle(page, { timeout: 3_000 })).rejects.toThrow();
	});
});
