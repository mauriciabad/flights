import { describe, expect, it } from 'vitest';
import { SETTINGS_PROVIDER_IDS } from '$lib/settings/provider-catalog';
import { getProviderRegistry, unconfiguredStayProviders } from './provider-setup';

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

/**
 * Issue #374. A keyless visitor gets Hostelworld's catalogue and nothing else, and the two
 * sentences built on this list have to name the providers that are actually missing rather
 * than the pair that happened to be missing the day the wording was written.
 *
 * The exact labels are asserted, not just the count, because they are what reaches a
 * traveller's screen through `stays/no-stays-reason.ts`. A renamed adapter changes a
 * sentence, so it should change a test.
 */
describe('unconfiguredStayProviders', () => {
	it('names both keyed providers for a visitor who has pasted in nothing', () => {
		expect(unconfiguredStayProviders({})).toEqual(['Agoda (RapidAPI)', 'Booking.com (RapidAPI)']);
	});

	it('drops a provider the moment its key is saved', () => {
		expect(unconfiguredStayProviders({ agoda: { apiKey: 'k' } })).toEqual(['Booking.com (RapidAPI)']);
	});

	it('is empty once every stay provider can be called', () => {
		expect(unconfiguredStayProviders({ agoda: { apiKey: 'k' }, booking: { apiKey: 'k' } })).toEqual([]);
	});

	// A form that clears a field to "" rather than deleting it reads as unconfigured
	// (`providers/registry.ts`'s `isProviderUsable`), so the offer to add a key stays.
	it('counts a blank key as no key', () => {
		expect(unconfiguredStayProviders({ agoda: { apiKey: '  ' } })).toContain('Agoda (RapidAPI)');
	});

	// The keyless baseline is never on this list, which is what stops the notice offering a
	// key for the one provider that has already answered.
	it('never names the provider that needs no key', () => {
		expect(unconfiguredStayProviders({}).join(' ')).not.toContain('Hostelworld');
	});
});
