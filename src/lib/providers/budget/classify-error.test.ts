import { describe, expect, it } from 'vitest';
import { ProviderHttpError, defaultClassifyError } from './classify-error';

describe('defaultClassifyError', () => {
	it('classifies a 429 ProviderHttpError as rate-limited', () => {
		expect(defaultClassifyError(new ProviderHttpError(429, 'Too Many Requests'))).toBe('rate-limited');
	});

	it('classifies the exact RapidAPI "not subscribed" body as not-subscribed', () => {
		const error = new ProviderHttpError(403, 'You are not subscribed to this API.');
		expect(defaultClassifyError(error)).toBe('not-subscribed');
	});

	it('classifies a 403 with an unrelated message as unknown, not not-subscribed', () => {
		const error = new ProviderHttpError(403, 'Forbidden: invalid key');
		expect(defaultClassifyError(error)).toBe('unknown');
	});

	it('classifies any other ProviderHttpError status as unknown', () => {
		expect(defaultClassifyError(new ProviderHttpError(500, 'Internal Server Error'))).toBe('unknown');
	});

	it('recognises the not-subscribed message on a plain thrown object, not just ProviderHttpError', () => {
		expect(defaultClassifyError({ message: 'You are not subscribed to this API.' })).toBe('not-subscribed');
	});

	it('classifies an aborted fetch as cancelled', () => {
		const abortError = new DOMException('The operation was aborted', 'AbortError');
		expect(defaultClassifyError(abortError)).toBe('cancelled');
	});

	it('classifies a generic fetch TypeError as network-error', () => {
		expect(defaultClassifyError(new TypeError('Failed to fetch'))).toBe('network-error');
	});

	it('classifies anything unrecognised as unknown rather than guessing', () => {
		expect(defaultClassifyError(new Error('something else went wrong'))).toBe('unknown');
		expect(defaultClassifyError('a bare string')).toBe('unknown');
		expect(defaultClassifyError(undefined)).toBe('unknown');
	});
});
