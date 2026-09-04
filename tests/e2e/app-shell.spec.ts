import { test, expect } from './support/fixtures';

/**
 * The one screen that exists today. Everything else in issue #18 — the search form,
 * the results list, the comparator — is still mid-build behind other issues, so this
 * file only asserts what is actually true right now: the static site boots, hydrates,
 * and doesn't throw.
 */
test.describe('app shell', () => {
	test('loads, hydrates and renders without console or page errors', async ({ page }) => {
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});

		const pageErrors: string[] = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));

		const response = await page.goto('/');
		expect(response?.ok(), 'the initial HTML response should be a 2xx').toBe(true);

		await page.waitForLoadState('networkidle');

		// A crash during hydration can leave the body empty even though the server sent
		// real markup, so this is checked before anything else.
		const bodyText = await page.locator('body').innerText();
		expect(bodyText.trim().length, 'the page should render visible content').toBeGreaterThan(0);

		expect(pageErrors, pageErrors.join('\n')).toEqual([]);
		expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
	});
});
