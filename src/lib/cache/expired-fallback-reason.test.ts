import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyExpiredFallbackReason } from './expired-fallback-reason';

describe('classifyExpiredFallbackReason', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('passes a quota-exceeded error through with its own message', () => {
		const error = { code: 'quota-exceeded', message: 'Monthly quota used up.', status: 429 };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'quota-exceeded',
			message: 'Monthly quota used up.'
		});
	});

	it('passes a not-subscribed error through with its own message', () => {
		const error = { code: 'not-subscribed', message: 'Not subscribed to this API.', status: 403 };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'not-subscribed',
			message: 'Not subscribed to this API.'
		});
	});

	it('passes a network-error through with its own message', () => {
		const error = { code: 'network-error', message: 'Failed to fetch.' };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'network-error',
			message: 'Failed to fetch.'
		});
	});

	it('fills in a default message when a recognised error carries none', () => {
		const error = { code: 'quota-exceeded' };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'quota-exceeded',
			message: "This provider's request quota is used up for now."
		});
	});

	it('reports offline when the browser is offline, regardless of what the error says', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

		// Even a quota-shaped error takes a back seat to "you are offline",
		// since that is the more useful, more certain answer for the user.
		const error = { code: 'quota-exceeded', message: 'Monthly quota used up.' };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'offline',
			message: 'The browser is offline.'
		});
	});

	it('falls back to unknown with the Error message for an unrecognised Error', () => {
		expect(classifyExpiredFallbackReason(new Error('provider is down'))).toEqual({
			code: 'unknown',
			message: 'provider is down'
		});
	});

	it('falls back to unknown with a stringified value for a non-Error rejection', () => {
		expect(classifyExpiredFallbackReason('boom')).toEqual({
			code: 'unknown',
			message: 'boom'
		});
	});

	it('treats an object with an unrecognised code as unknown rather than guessing', () => {
		const error = { code: 'teapot', message: "I'm a teapot" };
		expect(classifyExpiredFallbackReason(error)).toEqual({
			code: 'unknown',
			message: String(error)
		});
	});
});
