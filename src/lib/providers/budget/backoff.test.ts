import { describe, expect, it } from 'vitest';
import { computeBackoffDelayMs } from './backoff';

describe('computeBackoffDelayMs', () => {
	it('doubles the exponential component each attempt, staying within its equal-jitter range', () => {
		// attempt 1: exponential = base (500) -> range [250, 500]
		expect(computeBackoffDelayMs(1, { random: () => 0 })).toBe(250);
		expect(computeBackoffDelayMs(1, { random: () => 1 })).toBe(500);

		// attempt 2: exponential = 1000 -> range [500, 1000]
		expect(computeBackoffDelayMs(2, { random: () => 0 })).toBe(500);
		expect(computeBackoffDelayMs(2, { random: () => 1 })).toBe(1000);

		// attempt 3: exponential = 2000 -> range [1000, 2000]
		expect(computeBackoffDelayMs(3, { random: () => 0 })).toBe(1000);
		expect(computeBackoffDelayMs(3, { random: () => 1 })).toBe(2000);
	});

	it('caps the delay so a flapping provider never waits minutes', () => {
		// base 500 doubling past maxDelayMs (8000 default) by attempt 6 (500*2^5=16000)
		expect(computeBackoffDelayMs(6, { random: () => 1 })).toBe(8_000);
		expect(computeBackoffDelayMs(10, { random: () => 1 })).toBe(8_000);
	});

	it('honours custom base and max delays', () => {
		expect(computeBackoffDelayMs(1, { baseDelayMs: 100, random: () => 0 })).toBe(50);
		expect(computeBackoffDelayMs(5, { baseDelayMs: 100, maxDelayMs: 300, random: () => 1 })).toBe(300);
	});

	it('defaults to Math.random when none is injected, staying within the expected range', () => {
		const delay = computeBackoffDelayMs(1);
		expect(delay).toBeGreaterThanOrEqual(250);
		expect(delay).toBeLessThanOrEqual(500);
	});
});
