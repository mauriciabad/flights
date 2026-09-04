import { beforeEach, describe, expect, it } from 'vitest';
import { isPermanentlyUnsubscribed, markNotSubscribed, resetPermanentFailuresForTests } from './permanent-failures';

beforeEach(() => {
	resetPermanentFailuresForTests();
});

describe('permanent not-subscribed tracking', () => {
	it('reports a provider as not permanently unsubscribed until marked', () => {
		expect(isPermanentlyUnsubscribed('sky-scrapper')).toBe(false);
	});

	it('remembers a provider marked not-subscribed', () => {
		markNotSubscribed('sky-scrapper');
		expect(isPermanentlyUnsubscribed('sky-scrapper')).toBe(true);
	});

	it('keeps other providers unaffected', () => {
		markNotSubscribed('sky-scrapper');
		expect(isPermanentlyUnsubscribed('flights-sky')).toBe(false);
	});

	it('clears on reset, simulating a fresh session', () => {
		markNotSubscribed('sky-scrapper');
		resetPermanentFailuresForTests();
		expect(isPermanentlyUnsubscribed('sky-scrapper')).toBe(false);
	});
});
