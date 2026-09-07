import { describe, expect, it } from 'vitest';
import { priceIsSettled, savedPriceNote, saveTripLabel } from './saved-trip';
import { makeObservation, makeSaved, money } from '../saved/test-support';

const places = { origin: 'Barcelona', connection: 'Sofia', destination: 'Paphos' };

describe('saveTripLabel', () => {
	it('names the trip and the action, and says something different in each state', () => {
		expect(saveTripLabel(false, places)).toBe('Save Barcelona to Paphos via Sofia');
		expect(saveTripLabel(true, places)).toBe(
			'Remove Barcelona to Paphos via Sofia from saved trips'
		);
		expect(saveTripLabel(false, places)).not.toBe(saveTripLabel(true, places));
	});

	it('uses whatever the card is showing for the stopover, which is a code until the airport lands', () => {
		expect(saveTripLabel(false, { ...places, connection: 'SOF' })).toBe(
			'Save Barcelona to Paphos via SOF'
		);
	});
});

describe('priceIsSettled', () => {
	it('files a price the search has finished with', () => {
		expect(priceIsSettled({ tier: 'fresh', retrievedAgeMs: 4_000 })).toBe(true);
	});

	it('refuses a price the search is still assembling', () => {
		expect(priceIsSettled({ tier: 'stale', retrievedAgeMs: 4_000 })).toBe(false);
	});

	it('refuses an expired copy shown because a provider is failing', () => {
		expect(
			priceIsSettled({
				tier: 'expired-fallback',
				retrievedAgeMs: 90_000,
				reason: 'down',
				message: 'Failed to fetch'
			})
		).toBe(false);
	});
});

describe('savedPriceNote', () => {
	it('says nothing about a trip nobody saved', () => {
		expect(savedPriceNote(undefined)).toBeUndefined();
	});

	it('says nothing on the visit the trip was saved in, when one price is all there is', () => {
		expect(savedPriceNote(makeSaved())).toBeUndefined();
	});

	it('compares today against the price it was saved at', () => {
		const entry = makeSaved({
			prices: [
				makeObservation({ visit: 'v1', total: money(18_200) }),
				makeObservation({ visit: 'v2', total: money(17_800) })
			]
		});
		expect(savedPriceNote(entry)?.short).toBe('€4.00 cheaper');
		expect(savedPriceNote(entry)?.direction).toBe('cheaper');
	});

	it('refuses to subtract two currencies rather than inventing a rate', () => {
		const entry = makeSaved({
			prices: [
				makeObservation({ visit: 'v1', total: money(18_200) }),
				makeObservation({ visit: 'v2', total: money(15_400, 'GBP') })
			]
		});
		expect(savedPriceNote(entry)?.direction).toBe('incomparable');
	});
});
