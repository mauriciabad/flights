import { test as base, expect } from '@playwright/test';
import { installNetworkGuard } from './network-guard';
import { mockAirlineLogos } from './providers';

/**
 * The `test`/`expect` every spec in this suite imports instead of `@playwright/test`
 * directly. It is identical except for two things: it blocks any request that leaves
 * the app's own origin unless a test mocked it first (see `network-guard.ts`), and it
 * mocks airline logos globally (see below), for every spec, before either the guard or
 * the test body runs.
 *
 * `guard.spec.ts` fails the whole suite if a spec file imports from `@playwright/test`
 * instead of here, so this can't be quietly bypassed by a new test file.
 */
export const test = base.extend<{ forbidRealNetwork: void }>({
	forbidRealNetwork: [
		async ({ context, baseURL }, use) => {
			const guard = installNetworkGuard(context, baseURL);
			await guard.ready;
			// Issue #119: `AirlineLogo.svelte` renders inside `ResultCard`/`ItineraryTimeline`,
			// which several specs reach without ever calling `mockAllKeylessProviders` (a demo
			// route rendering static fixture itineraries, say) — this isn't a "provider" those
			// specs are opting into, it's a static asset dependency of the UI itself, the same
			// way the hand-drawn mode icons need no mock at all. Registered after the guard
			// above (newer route, asked first, per network-guard.ts's own comment on ordering)
			// so it answers before the guard would otherwise block it, and before the test body
			// runs so a spec that wants different logo behaviour can still register its own
			// `context.route()` afterward and win, per the same ordering rule.
			await mockAirlineLogos(context);
			await use();
			guard.assertNothingWasBlocked();
		},
		{ auto: true }
	]
});

export { expect };
