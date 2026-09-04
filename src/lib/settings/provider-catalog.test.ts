import { describe, expect, it } from 'vitest';
import { SETTINGS_PROVIDERS } from './provider-catalog';

describe('SETTINGS_PROVIDERS', () => {
	it('has no duplicate ids', () => {
		const ids = SETTINGS_PROVIDERS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('declares at least one key field per provider (all four need a RapidAPI key)', () => {
		for (const provider of SETTINGS_PROVIDERS) {
			expect(provider.keyFields.length).toBeGreaterThan(0);
		}
	});

	it('every key field has a non-empty id and label', () => {
		for (const provider of SETTINGS_PROVIDERS) {
			for (const field of provider.keyFields) {
				expect(field.id.length).toBeGreaterThan(0);
				expect(field.label.length).toBeGreaterThan(0);
			}
		}
	});

	it('points the pricing link at a different URL than the general help link, per provider', () => {
		// The whole reason issue #29 keeps these separate: "get a key" and "subscribe to
		// the free BASIC plan" are different pages a user needs at different moments.
		for (const provider of SETTINGS_PROVIDERS) {
			for (const field of provider.keyFields) {
				expect(provider.pricingUrl).not.toBe(field.helpUrl);
				expect(provider.pricingUrl).toContain('/pricing');
			}
		}
	});

	it('has a positive monthly quota for every provider (all four are metered RapidAPI plans)', () => {
		for (const provider of SETTINGS_PROVIDERS) {
			expect(provider.monthlyQuota).toBeGreaterThan(0);
		}
	});

	it('matches the quotas measured in docs/PROVIDERS.md (2026-09-04)', () => {
		const quotas = Object.fromEntries(SETTINGS_PROVIDERS.map((p) => [p.id, p.monthlyQuota]));
		expect(quotas).toEqual({
			skyscanner: 20,
			'flights-sky': 50,
			booking: 50,
			agoda: 500
		});
	});

	it('builds a valid, key-free check URL for every provider', () => {
		for (const provider of SETTINGS_PROVIDERS) {
			const url = new URL(`https://${provider.check.host}${provider.check.path}`);
			expect(url.protocol).toBe('https:');
			expect(url.host).toBe(provider.check.host);
		}
	});

	it('computes params() fresh, with no empty values, for every provider', () => {
		for (const provider of SETTINGS_PROVIDERS) {
			const params = provider.check.params();
			expect(Object.keys(params).length).toBeGreaterThan(0);
			for (const value of Object.values(params)) {
				expect(value.length).toBeGreaterThan(0);
			}
		}
	});

	it('computes any check-in/check-out date param in the future, not baked in as a stale constant', () => {
		// Agoda and Booking's own RapidAPI wrappers reject a past check-in date — this
		// guards against `params()` ever regressing back to a hardcoded string literal,
		// which would eventually make the settings "test" button fail for a reason that
		// looks exactly like a bad key.
		const today = new Date().toISOString().slice(0, 10);
		for (const provider of SETTINGS_PROVIDERS) {
			const params = provider.check.params();
			for (const [key, value] of Object.entries(params)) {
				if (/date/i.test(key)) expect(value > today).toBe(true);
			}
		}
	});
});
