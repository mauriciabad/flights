import { describe, expect, it } from 'vitest';
import { decodeRing, encodeRing, encodeSigned, RING_SEPARATOR } from './coastline-codec';

describe('coastline codec', () => {
	it('round-trips a ring exactly, because a coastline is stored once and read back forever', () => {
		const ring: [number, number][] = [
			[0, 0],
			[3, -2],
			[300, 400],
			[-1200, 17],
			[0, 0]
		];

		expect(Array.from(decodeRing(encodeRing(ring)))).toEqual(ring.flat());
	});

	it('spends one character on a small step, which is what almost every step is', () => {
		expect(encodeSigned(0)).toHaveLength(1);
		expect(encodeSigned(15)).toHaveLength(1);
		expect(encodeSigned(-15)).toHaveLength(1);
		expect(encodeSigned(16)).toHaveLength(2);
	});

	it('never emits the ring separator, or one ring would swallow the next', () => {
		let encoded = '';
		for (let value = -5000; value <= 5000; value += 7) encoded += encodeSigned(value);

		expect(encoded).not.toContain(RING_SEPARATOR);
	});

	it('refuses a payload it cannot read rather than returning a shifted coastline', () => {
		expect(() => decodeRing('00~00')).toThrow(/unexpected character/);
	});
});
