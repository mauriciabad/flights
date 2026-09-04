import { test, expect } from './support/fixtures';
import { mockAllKeylessProviders, AIRLINE_LOGO_BASE_URL } from './support/providers';

/**
 * Issue #119: `AirlineLogo.svelte` falls back to a styled monogram when the real logo
 * request fails — this is the path an actual user gets whenever `pics.avs.io` is slow,
 * down, or blocked by an extension, not a hypothetical. `fixtures.ts` mocks that host
 * globally with a real stub image for every other spec; this one overrides that mock for
 * Ryanair specifically (Playwright gives the most-recently-registered matching route
 * first refusal, same pattern `select-and-compare.spec.ts` already uses to narrow a
 * shared mock) so the failure path actually fires, and asserts the fallback that reaches
 * the screen — not just that the component has an `onerror` handler.
 */
test.describe('airline logo fallback (issue #119)', () => {
	test('shows a styled monogram, not a broken image, when the logo request fails', async ({ page }) => {
		await mockAllKeylessProviders(page.context());

		// Registered after mockAllKeylessProviders (and after fixtures.ts's own global
		// airline-logo mock), so this one wins for Ryanair's logo specifically.
		await page.context().route(`${AIRLINE_LOGO_BASE_URL}/**/FR.png`, (route) => route.abort('failed'));

		await page.goto('/results/?dep=2026-10-01&arr=2026-10-20&from=BCN&to=TLL');
		await expect(page.getByText('still searching')).toHaveCount(0, { timeout: 20_000 });

		const card = page.locator('.result-card').first();
		await expect(card).toBeVisible();

		// Ryanair operates every fixture fare in this suite (`ryanair/one-way-fares.json`),
		// so both airline chips on the card are its logo — both should have fallen back.
		const monograms = card.locator('.airline-monogram');
		await expect(monograms.first()).toBeVisible();
		await expect(monograms.first()).toHaveText('RY');
		// Never a broken image left in the DOM alongside the fallback — `AirlineLogo.svelte`
		// swaps to the monogram entirely, it doesn't overlay it on a failed `<img>`.
		await expect(card.locator('img.airline-logo')).toHaveCount(0);
	});
});
