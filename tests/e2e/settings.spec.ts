import { test, expect } from './support/fixtures';

/**
 * Settings: API keys (issue #29). Covers the acceptance criteria named directly in the
 * issue: a wrong key names the provider rather than failing generically, and the
 * "not subscribed" 403 renders differently from an invalid key, because they need
 * different fixes (subscribe on RapidAPI vs. paste a different key).
 *
 * Every provider here is reached through RapidAPI, so every scenario mocks
 * `sky-scrapper.p.rapidapi.com` directly with `page.context().route(...)` rather than
 * `mockSkyscanner` from `support/providers.ts` — that helper answers with a realistic
 * *search* fixture, useful once an adapter drives it, but this suite needs to control
 * the exact status code and body the settings screen's own health check receives.
 */

const SKY_SCRAPPER_HOST = 'https://sky-scrapper.p.rapidapi.com/**';
const TEST_KEY = 'sk-e2e-test-key-1234';

test.describe('settings: API keys', () => {
	test('lists every provider with what it unlocks, and states the privacy policy', async ({ page }) => {
		await page.goto('/settings/');

		await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Skyscanner (Sky Scrapper)' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Flights Sky' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Booking.com' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Agoda' })).toBeVisible();

		await expect(page.getByText(/stored only in this browser/i)).toBeVisible();
		await expect(page.getByText(/never to any server this app runs/i)).toBeVisible();
	});

	test('every card in the provider list renders its heading through Card\'s header slot, including the first, after hydration (issue #77)', async ({
		page
	}) => {
		// This page is the real, permanent regression coverage for issue #77: `Card`'s
		// `header` snippet prop was suspected of dropping the first card's heading after
		// hydration, so `ProviderKeyCard.svelte` rendered its heading as plain body
		// content instead. Checking against the accessible heading name alone (the test
		// above) would pass either way, since an `<h3>` reads the same to a screen reader
		// whether it sits in `Card`'s `.card-header` or in its `.card-body`. This test
		// checks the DOM structure itself, against a real production build served the
		// way GitHub Pages serves it (see playwright.config.ts) and hydrated by a real
		// browser, not SSR output alone — so a regression here would fail this test even
		// though it renders exactly the same to assistive tech.
		await page.goto('/settings/');

		const cards = page.locator('.provider-card');
		await expect(cards).toHaveCount(4);

		const count = await cards.count();
		for (let i = 0; i < count; i++) {
			const card = cards.nth(i);
			await expect(card.locator('.card-header')).toBeVisible();
			await expect(card.locator('.card-header h3')).not.toBeEmpty();
		}

		// The first card by itself, named explicitly: this is the exact position issue
		// #77 named as the one that silently lost its header.
		const firstCard = cards.first();
		await expect(firstCard.locator('.card-header')).toContainText('Skyscanner (Sky Scrapper)');
	});

	test('saving a key redacts it to the last 4 characters, and the raw value never appears again', async ({
		page
	}) => {
		await page.goto('/settings/');

		const card = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await card.getByLabel('RapidAPI key').fill(TEST_KEY);

		// The Test button's own health check would otherwise fire the moment Save is
		// pressed (issue #29: "paste a key, see it validated") and hit the real network —
		// mock a boring success so this test only has to assert the redaction, not the
		// health-check UI, which the next tests cover.
		await page.context().route(SKY_SCRAPPER_HOST, (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":true}' })
		);
		await card.getByRole('button', { name: 'Save' }).click();

		await expect(card.getByText('••••1234')).toBeVisible();
		await expect(page.locator('body')).not.toContainText(TEST_KEY);

		// Reload to prove it round-tripped through localStorage, not just component state.
		await page.reload();
		const cardAfterReload = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await expect(cardAfterReload.getByText('••••1234')).toBeVisible();
	});

	test('a "not subscribed" 403 is distinguished from an invalid key, with a link to the pricing page', async ({
		page
	}) => {
		await page.goto('/settings/');
		const card = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await card.getByLabel('RapidAPI key').fill(TEST_KEY);

		await page.context().route(SKY_SCRAPPER_HOST, (route) =>
			route.fulfill({
				status: 403,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'You are not subscribed to this API.' })
			})
		);
		await card.getByRole('button', { name: 'Save' }).click();

		await expect(card.getByText('Not subscribed on RapidAPI')).toBeVisible();
		const subscribeLink = card.getByRole('link', { name: /subscribe to the free basic plan/i });
		await expect(subscribeLink).toBeVisible();
		await expect(subscribeLink).toHaveAttribute('href', 'https://rapidapi.com/apiheya/api/sky-scrapper/pricing');

		// The invalid-key wording must never appear for this failure — that's the whole
		// point of telling the two apart.
		await expect(card.getByText('Key rejected')).not.toBeVisible();
	});

	test('an invalid key is reported as a key problem, not a subscription problem', async ({ page }) => {
		await page.goto('/settings/');
		const card = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await card.getByLabel('RapidAPI key').fill('not-a-real-key');

		await page.context().route(SKY_SCRAPPER_HOST, (route) =>
			route.fulfill({
				status: 403,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Invalid API key.' })
			})
		);
		await card.getByRole('button', { name: 'Save' }).click();

		await expect(card.getByText('Key rejected')).toBeVisible();
		await expect(card.getByRole('link', { name: /subscribe/i })).toHaveCount(0);
		await expect(card.getByText('Not subscribed on RapidAPI')).not.toBeVisible();
	});

	test('a used-up free tier is reported as quota exhaustion, naming the provider', async ({ page }) => {
		await page.goto('/settings/');
		const card = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await card.getByLabel('RapidAPI key').fill(TEST_KEY);

		await page.context().route(SKY_SCRAPPER_HOST, (route) =>
			route.fulfill({
				status: 429,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Too many requests' })
			})
		);
		await card.getByRole('button', { name: 'Save' }).click();

		await expect(card.getByText('Free-tier quota used up')).toBeVisible();
		await expect(card.getByText(/skyscanner \(sky scrapper\)/i).first()).toBeVisible();
	});

	test('exports the saved keys as a downloadable JSON file containing no plaintext surprises', async ({
		page
	}) => {
		await page.goto('/settings/');
		const card = page.locator('.provider-card', { hasText: 'Skyscanner (Sky Scrapper)' });
		await card.getByLabel('RapidAPI key').fill(TEST_KEY);
		await page.context().route(SKY_SCRAPPER_HOST, (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":true}' })
		);
		await card.getByRole('button', { name: 'Save' }).click();
		await expect(card.getByText('••••1234')).toBeVisible();

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Export keys as JSON' }).click()
		]);
		const stream = await download.createReadStream();
		const chunks: Buffer[] = [];
		for await (const chunk of stream ?? []) chunks.push(chunk as Buffer);
		const contents = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

		expect(contents.keys.skyscanner.apiKey).toBe(TEST_KEY);
		expect(typeof contents.exportedAt).toBe('string');
	});

	test('importing a keys file fills in a provider that had no key yet', async ({ page }) => {
		await page.goto('/settings/');

		const flightsSkyCard = page.locator('.provider-card', { hasText: 'Flights Sky' });
		await expect(flightsSkyCard.getByLabel('RapidAPI key')).toBeVisible();

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Import keys from JSON' }).click();
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'flights-api-keys.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify({
					version: 2,
					exportedAt: new Date().toISOString(),
					keys: { 'flights-sky': { apiKey: 'imported-key-5678' } }
				})
			)
		});

		await expect(page.getByText('Added 1, updated 0, left 0 unchanged.')).toBeVisible();
		await expect(flightsSkyCard.getByText('••••5678')).toBeVisible();
	});
});
