import { describe, expect, it } from 'vitest';
import { formatRelativeFetchTime, providerDisplayName, relativeShare } from './comparator-format';

describe('formatRelativeFetchTime', () => {
	const now = Date.parse('2026-09-04T12:00:00Z');

	it('reads as "just now" inside the same minute', () => {
		expect(formatRelativeFetchTime('2026-09-04T11:59:31Z', now)).toBe('just now');
	});

	it('reads in minutes under an hour old', () => {
		expect(formatRelativeFetchTime('2026-09-04T11:55:00Z', now)).toBe('5 minutes ago');
	});

	it('reads in hours under a day old', () => {
		expect(formatRelativeFetchTime('2026-09-04T09:00:00Z', now)).toBe('3 hours ago');
	});

	it('reads in days beyond a day old', () => {
		expect(formatRelativeFetchTime('2026-09-02T12:00:00Z', now)).toBe('2 days ago');
	});
});

describe('providerDisplayName', () => {
	it('capitalises the first letter of a lowercase provider id', () => {
		expect(providerDisplayName('skyscanner')).toBe('Skyscanner');
	});

	it('leaves an empty id as-is rather than throwing', () => {
		expect(providerDisplayName('')).toBe('');
	});
});

describe('relativeShare', () => {
	it('is 1 when the value equals the max', () => {
		expect(relativeShare(180, 180)).toBe(1);
	});

	it('is a fraction between 0 and 1 for a partial value', () => {
		expect(relativeShare(90, 180)).toBe(0.5);
	});

	it('is 0 when max is zero, instead of dividing by zero', () => {
		expect(relativeShare(90, 0)).toBe(0);
	});

	it('clamps a value larger than max to 1', () => {
		expect(relativeShare(400, 180)).toBe(1);
	});
});
