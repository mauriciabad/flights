import { describe, expect, it } from 'vitest';
import { SETTINGS_PROVIDER_IDS } from '$lib/settings/provider-catalog';
import { getProviderRegistry } from './provider-setup';

/**
 * Issue #128: Kiwi was registered here (issue #51) but never added to
 * `settings/provider-catalog.ts` (issue #29) — two changes that both looked complete on
 * their own, made by agents who could not see each other's issue. The result: the results
 * page's "widen this search" panel iterates every registered provider to offer "add a key
 * to use this" for whichever ones are not yet usable (`$lib/search/price-calendar.ts`'s
 * `estimatePriceCalendarWidenCost`), has no way to tell "not configured yet" apart from
 * "cannot ever be configured," and pointed a real traveller at a settings row that did not
 * exist.
 *
 * This is the tripwire so that gap cannot reopen silently: a keyed adapter added to the
 * registry without a matching settings entry fails this test the moment it lands, instead
 * of shipping a dead link discovered by a user months later.
 */
describe('getProviderRegistry', () => {
	it('never registers a provider that needs a key settings has no way to configure', () => {
		const uncatalogued = getProviderRegistry()
			.all()
			.filter((provider) => provider.needsKey && !SETTINGS_PROVIDER_IDS.includes(provider.id));

		expect(uncatalogued.map((provider) => provider.id)).toEqual([]);
	});
});
