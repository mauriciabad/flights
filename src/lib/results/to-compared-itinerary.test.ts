import { describe, expect, it } from 'vitest';
import { makeScoredResult } from './test-support';
import { toComparedItinerary } from './to-compared-itinerary';

describe('toComparedItinerary', () => {
	it('carries the id and itinerary straight through', () => {
		const result = makeScoredResult({ id: 'VIE' });
		const compared = toComparedItinerary(result);
		expect(compared.id).toBe('VIE');
		expect(compared.itinerary).toBe(result.itinerary);
	});

	it('flattens each provenance part into a ProviderSource, dropping the part name and label', () => {
		const result = makeScoredResult();
		const compared = toComparedItinerary(result);
		expect(compared.sources).toEqual(
			result.price.parts.map((part) => ({ providerId: part.providerId, fetchedAt: part.fetchedAt }))
		);
	});

	it('produces an empty sources array, not undefined, when a result has no provenance parts', () => {
		const result = makeScoredResult();
		result.price.parts.length = 0;
		const compared = toComparedItinerary(result);
		expect(compared.sources).toEqual([]);
	});
});
