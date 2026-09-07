import { beforeEach, describe, expect, it } from 'vitest';
import { makeStopover } from '$lib/results/test-support';
import { buildSavedItinerary } from './build';
import { savedItineraryId } from './storage';
import { SavedItinerariesStore } from './store.svelte';

beforeEach(() => {
	localStorage.clear();
});

const QUERY = 'arr=2026-10-20&dep=2026-10-01&from=BCN&to=OTP';

function vienna(visit = 'v1', savedAt = 1_000) {
	return buildSavedItinerary({ query: QUERY, itinerary: makeStopover(), visit, savedAt });
}

function berlin(visit = 'v1', savedAt = 2_000) {
	return buildSavedItinerary({
		query: QUERY,
		itinerary: makeStopover({ connectionAirportCode: 'BER' }),
		visit,
		savedAt
	});
}

describe('SavedItinerariesStore', () => {
	it('remembers a trip across a reload', () => {
		new SavedItinerariesStore().save(vienna());

		// A second instance over the same localStorage is what a page load sees.
		const afterReload = new SavedItinerariesStore();
		expect(afterReload.entries).toHaveLength(1);
		expect(afterReload.entries[0].trip.connection.airport).toBe('VIE');
	});

	it('knows whether the trip on a card is already saved', () => {
		const store = new SavedItinerariesStore();
		expect(store.isSaved(savedItineraryId(QUERY, 'VIE'))).toBe(false);
		store.save(vienna());
		expect(store.isSaved(savedItineraryId(QUERY, 'VIE'))).toBe(true);
	});

	it('toggles off and stays off after a reload', () => {
		const store = new SavedItinerariesStore();
		expect(store.toggle(vienna())).toBe(true);
		expect(store.toggle(vienna())).toBe(false);
		expect(new SavedItinerariesStore().entries).toEqual([]);
	});

	it('keeps two stopovers of one search as two trips', () => {
		const store = new SavedItinerariesStore();
		store.save(vienna());
		store.save(berlin());
		expect(store.entries).toHaveLength(2);
	});

	it('saving a trip twice does not restart its price log', () => {
		const store = new SavedItinerariesStore();
		store.save(vienna('v1'));
		store.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v2', observedAt: 2_000 });
		store.save(vienna('v3', 9_000));

		expect(store.entries[0].prices).toHaveLength(2);
		expect(store.entries[0].savedAt).toBe(1_000);
	});

	it('files one price per visit and refuses a second from the same visit', () => {
		const store = new SavedItinerariesStore();
		store.save(vienna('v1'));

		// What a re-render does: same page, same token, several passes.
		store.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v1', observedAt: 1_100 });
		store.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v1', observedAt: 1_200 });
		expect(store.entries[0].prices).toHaveLength(1);

		store.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v2', observedAt: 2_000 });
		expect(store.entries[0].prices).toHaveLength(2);
	});

	it('records nothing for a trip nobody saved', () => {
		const store = new SavedItinerariesStore();
		store.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v1' });
		expect(store.entries).toEqual([]);
	});

	it('writes a refused visit nowhere, so a reload sees one price and not two', () => {
		new SavedItinerariesStore().save(vienna('v1'));
		const reopened = new SavedItinerariesStore();
		reopened.recordVisit({ query: QUERY, itinerary: makeStopover(), visit: 'v1', observedAt: 5_000 });
		expect(new SavedItinerariesStore().entries[0].prices).toHaveLength(1);
	});

	it('a removed trip stays gone after a reload', () => {
		const store = new SavedItinerariesStore();
		store.save(vienna());
		store.save(berlin());
		store.remove(store.entries[0].id);

		expect(new SavedItinerariesStore().entries).toHaveLength(1);
	});

	it('clearing empties the list and the storage behind it', () => {
		const store = new SavedItinerariesStore();
		store.save(vienna());
		store.clear();

		expect(store.entries).toEqual([]);
		expect(new SavedItinerariesStore().entries).toEqual([]);
	});
});
