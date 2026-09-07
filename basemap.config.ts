import { defineConfig, devices } from '@playwright/test';

/**
 * `pnpm basemap`. Is the basemap this app draws still keyless, and still a map? (#432)
 *
 * A supply check, not a test of this app. It runs on a schedule
 * (.github/workflows/basemap-supply.yml) rather than on a pull request, because what it
 * watches belongs to somebody else and changes on their calendar. CARTO's raster endpoint
 * did not start demanding a key on the day an agent looked at it; it changed at some point
 * and nothing noticed until a person read a picture and saw "API KEY REQUIRED" written
 * across it.
 *
 * Its own config rather than a spec in the e2e suite, for two reasons. It needs no build of
 * this app, so a broken build should not be able to hide a broken basemap or the other way
 * round. And it reaches the real network on purpose, which every spec under `tests/e2e/` is
 * forbidden to do.
 */

// Overridable for the reason playwright.config.ts's `E2E_PORT` is: a dozen worktrees share
// one machine and a fixed port silently attaches to somebody else's server.
const PORT = Number(process.env.BASEMAP_PORT ?? 4176);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: './tests/basemap',
	testMatch: '**/*.canary.ts',
	forbidOnly: !!process.env.CI,

	// No retries. A canary that only fails sometimes is reporting something that only
	// happens sometimes, and that is the finding, not the noise.
	retries: 0,
	workers: 1,

	// A cold vector style with no tiles cached takes seconds, and the check draws two of
	// them. Generous on purpose: a timeout here would read as an outage.
	timeout: 180_000,
	reporter: process.env.CI ? [['list'], ['github']] : [['list']],

	use: {
		baseURL,
		// Some hosts refuse Node's and headless Chromium's own User-Agent while serving a
		// browser one, and a 403 from that reads exactly like an outage. AGENTS.md has the
		// measurements. Ask as an ordinary browser, so a refusal means a refusal.
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
	},

	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

	webServer: {
		command: `node tests/basemap/support/maplibre-server.mjs ${PORT}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000
	}
});
