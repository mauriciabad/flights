import { describe, expect, it } from 'vitest';
import { redactKey } from './redact';

describe('redactKey', () => {
	it('keeps only the last 4 characters', () => {
		expect(redactKey('sk-abcdef1234567890')).toBe('••••7890');
	});

	it('fully masks a key of 4 characters or fewer instead of revealing all of it', () => {
		expect(redactKey('abcd')).toBe('••••');
		expect(redactKey('ab')).toBe('••••');
		expect(redactKey('')).toBe('••••');
	});
});
