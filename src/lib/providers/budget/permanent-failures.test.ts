import { beforeEach, describe, expect, it } from 'vitest';
import { isPermanentlyUnsubscribed, markNotSubscribed, resetPermanentFailuresForTests } from './permanent-failures';

beforeEach(() => {
	resetPermanentFailuresForTests();
});

describe('permanent not-subscribed tracking', () => {
	it('reports a provider as not permanently unsubscribed until marked', () => {
		expect(isPermanentlyUnsubscribed('skyscanner')).toBe(false);
	});

	it('remembers a provider marked not-subscribed', () => {
		markNotSubscribed('skyscanner');
		expect(isPermanentlyUnsubscribed('skyscanner')).toBe(true);
	});

	it('keeps other providers unaffected', () => {
		markNotSubscribed('skyscanner');
		expect(isPermanentlyUnsubscribed('flights-sky')).toBe(false);
	});

	it('clears on reset, simulating a fresh session', () => {
		markNotSubscribed('skyscanner');
		resetPermanentFailuresForTests();
		expect(isPermanentlyUnsubscribed('skyscanner')).toBe(false);
	});
});
