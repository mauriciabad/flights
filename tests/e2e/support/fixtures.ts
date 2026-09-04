import { test as base, expect } from '@playwright/test';
import { installNetworkGuard } from './network-guard';

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
			await use();
			guard.assertNothingWasBlocked();
		},
		{ auto: true }
	]
});

export { expect };
