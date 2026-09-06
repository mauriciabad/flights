import { test as base, expect } from '@playwright/test';
import { pinBundledRouteData } from './bundled-data';
import { installNetworkGuard } from './network-guard';
import { mockAirlineLogos } from './providers';

/**
 * The `test`/`expect` every spec in this suite imports instead of `@playwright/test`
 * directly. It is identical except for one thing: it blocks any request that leaves
 * the app's own origin unless a test mocked it first (see `network-guard.ts`).
 *
 * `guard.spec.ts` fails the whole suite if a spec file imports from `@playwright/test`
 * instead of here, so this can't be quietly bypassed by a new test file.
 */
export const test = base.extend<{ forbidRealNetwork: void }>({
	forbidRealNetwork: [
		async ({ context, baseURL }, use) => {
			const guard = installNetworkGuard(context, baseURL);
			await guard.ready;
			// Airline logos are a UI dependency, not a provider a spec opts into: any page
			// that renders a flight requests one. Registered here rather than inside
			// `mockAllKeylessProviders` so a spec that mocks nothing at all still does not
			// trip the guard on an image.
			await mockAirlineLogos(context);
			// The bundled route graphs, for the same reason and at the same moment: no spec
			// opts into them, every spec that searches ranks against them, and until issue
			// #379 they were the real 224-airport shipped data behind a fixture naming
			// fourteen. Registered after the guard so it wins, and before the test body so a
			// spec can replace it. See support/bundled-data.ts.
			await pinBundledRouteData(context);
			await use();
			guard.assertNothingWasBlocked();
		},
		{ auto: true }
	]
});

export { expect };

/** Re-exported so a spec types a helper's `page` parameter from the same place it gets
 *  `test` and `expect`, rather than opening a second import line to '@playwright/test'.
 *  A type-only import there would be safe, since it is erased before anything runs and
 *  `guard.spec.ts` knows that after issue #382. One import is still better than two. */
export type { Page } from '@playwright/test';
