import {
	clearSavedItineraries,
	forgetItinerary,
	isRepeatVisit,
	loadSavedItineraries,
	recordPrice,
	saveItinerary,
	savedItineraryId,
	writeSavedItineraries
} from './storage';
import { buildPriceObservation } from './build';
import type { Itinerary } from '$lib/domain';
import type { SavedItinerary, SavedItineraryId, VisitToken } from './types';

/**
 * The saved list for the whole app lifetime, not one component tree.
 *
 * Three screens read and write it and none of them is an ancestor of the others: the heart
 * on a result card, the section on the search screen, and `/saved/`. That is the case
 * AGENTS.md names for a module-level rune holder rather than plain `$state` inside a
 * component, and it is the same reason `SearchHistoryStore` next door is one, so there is
 * one shape to learn for both.
 *
 * The class is exported alongside the singleton so a test can build a second instance
 * against the same `localStorage` and see what a reload would see.
 */
export class SavedItinerariesStore {
	#entries = $state<SavedItinerary[]>([]);

	constructor() {
		this.#entries = loadSavedItineraries();
	}

	/** Newest save first. */
	get entries(): readonly SavedItinerary[] {
		return this.#entries;
	}

	get(id: SavedItineraryId): SavedItinerary | undefined {
		return this.#entries.find((entry) => entry.id === id);
	}

	/** What a heart reads to know whether it is filled. */
	isSaved(id: SavedItineraryId): boolean {
		return this.#entries.some((entry) => entry.id === id);
	}

	/** Keeps this trip. Saving one that is already kept changes nothing, including its
	 * `savedAt` and its price log; see `saveItinerary`. */
	save(entry: SavedItinerary): void {
		this.#commit(saveItinerary(this.#entries, entry));
	}

	remove(id: SavedItineraryId): void {
		if (!this.isSaved(id)) return;
		this.#commit(forgetItinerary(this.#entries, id));
	}

	/** The heart, as one call. Returns whether the trip is saved now, so a caller can
	 * announce the change without reading the list back. */
	toggle(entry: SavedItinerary): boolean {
		if (this.isSaved(entry.id)) {
			this.remove(entry.id);
			return false;
		}
		this.save(entry);
		return true;
	}

	/**
	 * Files what this trip costs on this visit, if this trip is saved.
	 *
	 * The one call the results page makes. It takes the live itinerary rather than a built
	 * observation so the stored receipt is derived in one place, and it takes the visit
	 * token so a re-render cannot append a second row for one visit (see
	 * `appendObservation`). A trip nobody saved records nothing, so the page can hand every
	 * card on screen to this and only the kept ones grow a log.
	 */
	recordVisit(input: {
		/** The normalised query the card was found under, the same string used to save it. */
		query: string;
		itinerary: Itinerary;
		visit: VisitToken;
		observedAt?: number;
	}): void {
		const id = savedItineraryId(input.query, input.itinerary.outboundFlight.arrivalAirport);
		const existing = this.get(id);
		if (!existing) return;
		// Asked here as well as inside `appendObservation`, so a refused visit never reaches
		// `localStorage` and never wakes the `$derived` that redraws a chart. Both readers
		// call the same predicate; that is why it has a name.
		if (isRepeatVisit(existing.prices, input.visit)) return;
		const observation = buildPriceObservation({
			itinerary: input.itinerary,
			visit: input.visit,
			observedAt: input.observedAt
		});
		this.#commit(recordPrice(this.#entries, id, observation));
	}

	clear(): void {
		this.#entries = [];
		clearSavedItineraries();
	}

	#commit(next: SavedItinerary[]): void {
		this.#entries = next;
		if (next.length === 0) clearSavedItineraries();
		else writeSavedItineraries(next);
	}
}

export const savedItineraries = new SavedItinerariesStore();
