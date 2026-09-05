import { expect, test } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, mockHostelworld, routeRyanairFlights } from './support/providers';

/**
 * How `docs/screenshots/279-bed-*.png` were made, kept so the next person can remake them
 * rather than guess at the setup.
 *
 * Not a test, and it asserts nothing worth gating on. It is skipped unless `SHOT_LABEL` is
 * set, so `pnpm test:e2e` never rewrites checked-in images as a side effect of running the
 * suite:
 *
 *     SHOT_LABEL=after pnpm test:e2e picked-bed-screenshots
 *
 * The `before` set was captured the same way with `git checkout origin/main --
 * src/lib/components/StopoverBlock.svelte src/lib/stays/index.ts` in place, then restored.
 * That is also where the height figures in the PR come from: the `MEASURED` line each run
 * prints reads the real laid-out box rather than estimating it.
 */

const EMPTY_MAP_STYLE = JSON.stringify({ version: 8, name: 'empty', sources: {}, layers: [] });
const LABEL = process.env.SHOT_LABEL;

test.skip(!LABEL, 'Screenshot capture. Set SHOT_LABEL to run it.');

function photo(label: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a4d5e"/><stop offset="1" stop-color="#1b2b3a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="120" y="560" width="520" height="380" fill="#3b6b7d"/><rect x="700" y="420" width="700" height="520" fill="#31596b"/><circle cx="1280" cy="220" r="90" fill="#e9c46a"/><text x="80" y="140" font-size="72" fill="#e9c46a" font-family="monospace">FIXTURE ${label}</text></svg>`;
}

for (const scheme of ['dark', 'light'] as const) {
	for (const width of [375, 1280]) {
		test(`shot ${LABEL ?? '(set SHOT_LABEL)'} ${scheme} ${width}`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			await mockAllKeylessProviders(page.context());
			await mockHostelworld(
				page.context(),
				'hostelworld/continents-vienna.json',
				'hostelworld/properties-vienna-photos.json'
			);
			await page.context().route('https://photos.fixture.invalid/**', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'image/svg+xml',
					body: photo(route.request().url().includes('one') ? 'ONE' : 'TWO')
				})
			);
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

			await page.setViewportSize({ width, height: 900 });
			await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
			await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
			await page.getByRole('button', { name: 'Show details' }).first().click();

			const block = page.locator('.stopover').first();
			await expect(block).toBeVisible();
			await block.scrollIntoViewIfNeeded();
			await page.waitForTimeout(700);
			await block.screenshot({ path: `docs/screenshots/279-bed-${LABEL}-${scheme}-${width}.png` });

			const measured = await block.evaluate((el) => {
				const stay = el.querySelector('.stopover-stay') as HTMLElement | null;
				const media = el.querySelector('.bed-media') as HTMLElement | null;
				const rail = el.querySelector('.bed-rail') as HTMLElement | null;
				return {
					stayHeight: stay?.getBoundingClientRect().height ?? 0,
					mediaWidth: media?.getBoundingClientRect().width ?? 0,
					mediaHeight: media?.getBoundingClientRect().height ?? 0,
					railOverflows: rail ? rail.scrollWidth > rail.clientWidth + 1 : false,
					blockOverflows: el.scrollWidth > el.clientWidth + 1
				};
			});
			console.log(`MEASURED ${LABEL} ${scheme} ${width}`, JSON.stringify(measured));
		});
	}
}
