import { describe, expect, it } from 'vitest';
import { makeScoredResult } from './test-support';
import { toComparedItinerary } from './to-compared-itinerary';
import { ComparisonSelectionStore } from './comparison-selection.svelte';

describe('ComparisonSelectionStore', () => {
	it('starts empty', () => {
		const store = new ComparisonSelectionStore();
		expect(store.items).toEqual([]);
	});

	it('holds whatever was set, in order', () => {
		const store = new ComparisonSelectionStore();
		const chosen = [toComparedItinerary(makeScoredResult({ id: 'VIE' })), toComparedItinerary(makeScoredResult({ id: 'PRG' }))];

		store.set(chosen);

		expect(store.items).toEqual(chosen);
	});

	it('replaces the previous selection rather than appending to it', () => {
		const store = new ComparisonSelectionStore();
		store.set([toComparedItinerary(makeScoredResult({ id: 'VIE' }))]);
		store.set([toComparedItinerary(makeScoredResult({ id: 'PRG' }))]);

		expect(store.items.map((item) => item.id)).toEqual(['PRG']);
	});

	it('clear empties the selection', () => {
		const store = new ComparisonSelectionStore();
		store.set([toComparedItinerary(makeScoredResult({ id: 'VIE' }))]);

		store.clear();

		expect(store.items).toEqual([]);
	});
});
