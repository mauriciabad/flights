import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });

for (const scheme of ['dark', 'light'] as const) {
	test(`shots ${scheme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await mockAllKeylessProviders(page.context());
		await routeRyanairFlights(page.context(), [
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-08T08:00:00',
				arrDate: '2027-03-08T10:15:00',
				price: FIXTURE_PRICES.first,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[2]
			},
			{
				dep: 'BCN',
				arr: 'VIE',
				depDate: '2027-03-09T16:30:00',
				arrDate: '2027-03-09T18:45:00',
				price: FIXTURE_PRICES.second,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[3]
			},
			{
				dep: 'VIE',
				arr: 'TLL',
				depDate: '2027-03-10T11:00:00',
				arrDate: '2027-03-10T13:20:00',
				price: FIXTURE_PRICES.third,
				flightNumber: FIXTURE_FLIGHT_NUMBERS[4]
			}
		]);
		await page.context().route('https://basemaps.cartocdn.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_MAP_STYLE })
		);
		await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		await page.setViewportSize({ width: 375, height: 812 });
		await page.screenshot({ path: `docs/screenshots/278-card-after-${scheme}-375.png` });

		await page.locator('.trip-strip-hit-stopover').first().click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `docs/screenshots/278-sheet-stopover-${scheme}-375.png` });

		await page.locator('.trip-strip-hit-flight').first().click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: `docs/screenshots/278-sheet-flight-${scheme}-375.png` });

		await page.locator('.customise-sheet').getByRole('button', { name: 'Close' }).click();
		await page.locator('.trip-strip-unfold').first().click();
		await page.waitForTimeout(700);
		await page.screenshot({
			path: `docs/screenshots/278-timeline-${scheme}-375.png`,
			fullPage: true
		});
		await page.locator('.trip-strip-unfold').first().click();

		await page.setViewportSize({ width: 1280, height: 900 });
		await page.waitForTimeout(400);
		await page.locator('.trip-strip-hit-flight').first().click();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `docs/screenshots/278-rail-flight-${scheme}-1280.png` });

		await page.locator('.trip-strip-hit-stopover').first().click();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `docs/screenshots/278-rail-stopover-${scheme}-1280.png` });

		await page.locator('.trip-strip-hit-wait').nth(1).click();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `docs/screenshots/278-rail-wait-${scheme}-1280.png` });
	});
}
