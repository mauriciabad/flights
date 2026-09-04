import { describe, expect, it } from 'vitest';
import { assertNoSecretLeakage, CacheSecretLeakageError } from './guard';

describe('assertNoSecretLeakage', () => {
	it('allows plain provider data', () => {
		expect(() =>
			assertNoSecretLeakage({ price: { amount: 4200, currency: 'EUR' }, airline: 'Ryanair' })
		).not.toThrow();
	});

	it('rejects a top-level apiKey field', () => {
		expect(() => assertNoSecretLeakage({ apiKey: 'abc123' })).toThrow(CacheSecretLeakageError);
	});

	it('rejects a nested authorization field, however deep', () => {
		const value = { flights: [{ meta: { request: { authorization: 'Bearer xyz' } } }] };
		expect(() => assertNoSecretLeakage(value)).toThrow(CacheSecretLeakageError);
	});

	it('rejects regardless of casing or punctuation in the field name', () => {
		expect(() => assertNoSecretLeakage({ 'X-RapidAPI-Key': 'abc' })).toThrow(
			CacheSecretLeakageError
		);
	});

	it('does not false-positive on field names that merely contain "token" as a substring', () => {
		expect(() =>
			assertNoSecretLeakage({ pageToken: 'abc', tokenCount: 3 })
		).not.toThrow();
	});

	it('does not loop forever on a circular structure', () => {
		const value: Record<string, unknown> = { name: 'self-referencing' };
		value.self = value;
		expect(() => assertNoSecretLeakage(value)).not.toThrow();
	});

	it('reports the offending field name on the error', () => {
		try {
			assertNoSecretLeakage({ secret: 'abc' });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CacheSecretLeakageError);
			expect((error as CacheSecretLeakageError).fieldName).toBe('secret');
		}
	});
});
