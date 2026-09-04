import type { BrowserContext } from '@playwright/test';

/**
 * Blocks every request a test doesn't explicitly allow, and remembers what it blocked.
 *
 * Skyscanner's free RapidAPI tier is 20 requests A MONTH. A single test run that forgets
 * to mock a provider call, or a typo in a mocked URL pattern, would burn a real request
 * against a real key — so every test in the default suite runs behind this guard, not
 * just the ones that happen to talk to a provider.
 *
 * How it works: this route is installed before the test body runs (see
 * `tests/e2e/support/fixtures.ts`), so it is the OLDEST registered route. Playwright
 * runs routes newest-first and only falls through to an older one when the newer
 * handler calls `route.fallback()`. A test's own `context.route('https://provider/**', ...)`
 * mock is therefore always asked first, and this guard only ever sees requests nothing
 * else wanted — same-origin app requests (allowed) or a genuinely unmocked provider call
 * (blocked and recorded, so the fixture can fail the test with a readable message
 * instead of the request hanging or a flaky "0 results" assertion).
 */
export function installNetworkGuard(context: BrowserContext, allowedOrigin: string | undefined) {
	const blocked: string[] = [];

	const guardPromise = context.route('**/*', async (route) => {
		const url = route.request().url();

		if (allowedOrigin && url.startsWith(allowedOrigin)) {
			await route.continue();
			return;
		}

		// Playwright's own instrumentation (about:blank, chrome-error pages, blob/data
		// URLs created client-side) never reaches a provider and never needs a mock.
		if (
			url.startsWith('data:') ||
			url.startsWith('blob:') ||
			url.startsWith('about:') ||
			url.startsWith('chrome-error:')
		) {
			await route.continue();
			return;
		}

		blocked.push(url);
		await route.abort('blockedbyclient');
	});

	return {
		ready: guardPromise,
		assertNothingWasBlocked() {
			if (blocked.length === 0) return;
			throw new Error(
				[
					`Network guard blocked ${blocked.length} request(s) that no mock answered:`,
					...blocked.map((url) => `  - ${url}`),
					'',
					'Tests never touch real provider APIs (the Skyscanner free tier is 20',
					'requests a month). Register a mock before navigating — see the helpers in',
					'tests/e2e/support/providers.ts, or tests/e2e/README.md to add a new one.',
					'A test that intentionally hits a real API belongs in tests/e2e/live/ and',
					"must be tagged '@live'."
				].join('\n')
			);
		}
	};
}
