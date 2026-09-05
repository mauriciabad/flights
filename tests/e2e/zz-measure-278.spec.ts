import { test, expect } from './support/fixtures';
import { FIXTURE_FLIGHT_NUMBERS, FIXTURE_PRICES } from './support/fixture-markers';
import { mockAllKeylessProviders, routeRyanairFlights } from './support/providers';

test('measure card parts', async ({ page }) => {
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
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/results/?dep=2027-03-08&arr=2027-03-27&from=BCN&to=TLL');
	await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });
	const parts = await page.locator('.result-card').first().evaluate((card) => {
		const rows: string[] = [];
		const walk = (el: Element, depth: number) => {
			for (const child of Array.from(el.children)) {
				const box = child.getBoundingClientRect();
				const name = (child.className || '').toString().split(' ').slice(0, 2).join('.');
				rows.push(`${'  '.repeat(depth)}${child.tagName.toLowerCase()}.${name} = ${Math.round(box.height)}`);
				if (depth < 2) walk(child, depth + 1);
			}
		};
		rows.push(`ROOT = ${Math.round(card.getBoundingClientRect().height)}`);
		walk(card, 0);
		return rows.join('\n');
	});
	console.log(parts);
});
