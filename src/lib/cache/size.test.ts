import { describe, expect, it } from 'vitest';
import { estimateByteSize } from './size';

describe('estimateByteSize', () => {
	it('grows with the serialised size of the value', () => {
		const small = estimateByteSize({ a: 1 });
		const large = estimateByteSize({ a: 1, b: 'x'.repeat(1000) });
		expect(large).toBeGreaterThan(small);
	});

	it('returns 0 for a value that cannot be serialised', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(estimateByteSize(circular)).toBe(0);
	});
});
