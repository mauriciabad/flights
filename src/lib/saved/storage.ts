/**
 * Where saved itineraries live, and the rules that decide what the list holds.
 *
 * Same rules as `search-history/storage.ts` next door, which is the module this mirrors:
 * `localStorage` only, every access wrapped, anything unreadable reads as "nothing saved"
 * rather than throwing. Losing the list is a smaller harm than a page that will not load.
 *
 * Everything here is pure except the four functions that touch `localStorage`, so the id
 * derivation, the visit-token rule and both caps are testable with two arrays.
 */

import { normaliseCurrencyCode } from '$lib/domain';
import type {
	IataAirportCode,
	ItineraryTransferLeg,
	LocalDateTime,
	Money,
	RoomKind,
	TransferMode
} from '$lib/domain';
import type {
	PriceObservation,
	SavedBed,
	SavedFlight,
	SavedGroundLeg,
	SavedItinerary,
	SavedItineraryId,
	SavedPlace,
	SavedTrip,
	VisitToken
} from './types';

/** Namespaced the same way `flights.searchHistory.v1` and `flights.byokKeys.v1` are, so no
 * two of them can shadow each other, and so a shape change gets a `.v2` rather than a
 * migration nobody wrote. */
const STORAGE_KEY = 'flights.savedItineraries.v1';

/**
 * How many trips the list keeps, newest save first.
 *
 * Larger than `MAX_HISTORY_ENTRIES`, which is 8, and for the opposite reason. History caps
 * small because yesterday's typo should fall off on its own. A saved trip is a deliberate
 * act, so the cap here is a guard rail against an unbounded list rather than a tidying
 * rule: twenty trips with a full price log each is under a tenth of a megabyte, well inside
 * what a browser gives one origin, and nobody hearts twenty trips by accident.
 */
export const MAX_SAVED_ITINERARIES = 20;

/**
 * How many price observations one trip keeps, oldest dropped first.
 *
 * Thirty visits is a couple of months of checking back weekly, or a month of checking
 * daily, and it is the window in which a fare movement is still about the same trip. The
 * cap exists for the same reason the one above does: a log that grows on every page load
 * is exactly the trap `MAX_HISTORY_ENTRIES` was written to avoid, one visit at a time.
 */
export const MAX_PRICE_OBSERVATIONS = 30;

/**
 * The id of one saved trip, from the search it was found in and the city it stops in.
 *
 * Both halves are stable for the whole of a search. `results/types.ts` says so about the
 * second: `ScoredResult.id` IS the connection airport code, "already the pipeline's own
 * stable per-stopover key", the thing `stream-order.ts` uses to update a card across
 * snapshots without moving it. And `normalizeQuery` makes the first stable against param
 * order. So a heart pressed on the Vienna card, a re-price of that card ten minutes later
 * and the row on `/saved/` a week afterwards all compute the same string without anybody
 * passing an id around.
 *
 * A pure function rather than a stored counter or a random id, because the two halves of
 * issue #434 ship as two pull requests and the results page has to be able to ask "is the
 * trip on this card already saved" from the card alone.
 *
 * `@` separates them because neither half can contain one: `URLSearchParams.toString()`
 * percent-encodes it, and an IATA code is three letters. So no pair of inputs collides,
 * which matters more than it looks. A collision merges two trips' price logs.
 */
export function savedItineraryId(query: string, connectionAirportCode: IataAirportCode): SavedItineraryId {
	return `${connectionAirportCode}@${query}`;
}

function readRaw(): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeRaw(raw: string): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(STORAGE_KEY, raw);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function money(value: unknown): Money | undefined {
	if (!isRecord(value)) return undefined;
	const minorUnits = count(value.minorUnits);
	const currency = normaliseCurrencyCode(value.currency);
	if (minorUnits === undefined || currency === undefined) return undefined;
	return { minorUnits, currency };
}

function localDateTime(value: unknown): LocalDateTime | undefined {
	if (!isRecord(value)) return undefined;
	const local = text(value.local);
	const timeZone = text(value.timeZone);
	const utcOffsetMinutes = count(value.utcOffsetMinutes);
	if (local === undefined || timeZone === undefined || utcOffsetMinutes === undefined) return undefined;
	return { local, timeZone, utcOffsetMinutes };
}

function place(value: unknown): SavedPlace | undefined {
	if (!isRecord(value)) return undefined;
	const airport = text(value.airport);
	const city = text(value.city);
	if (airport === undefined || city === undefined) return undefined;
	return { airport, city };
}

function flight(value: unknown): SavedFlight | undefined {
	if (!isRecord(value) || !isRecord(value.carrier)) return undefined;
	const iataCode = text(value.carrier.iataCode);
	const name = text(value.carrier.name);
	const flightNumber = text(value.flightNumber);
	const departureAirport = text(value.departureAirport);
	const arrivalAirport = text(value.arrivalAirport);
	const departure = localDateTime(value.departure);
	const arrival = localDateTime(value.arrival);
	if (iataCode === undefined || name === undefined || flightNumber === undefined) return undefined;
	if (departureAirport === undefined || arrivalAirport === undefined) return undefined;
	if (departure === undefined || arrival === undefined) return undefined;
	return {
		carrier: { iataCode, name },
		flightNumber,
		departureAirport,
		arrivalAirport,
		departure,
		arrival
	};
}

/** The three closed vocabularies a stored file could contradict, each with the guard that
 * checks a string against it. Listed rather than inferred from the domain types, because a
 * `RoomKind` added later has to be a decision here too: an old browser's file will not have
 * it, and a new one's must not read as corrupt. */
const ROOM_KINDS: readonly RoomKind[] = ['dorm', 'private', 'female-dorm', 'male-dorm'];
const TRANSFER_MODES: readonly TransferMode[] = ['walk', 'transit', 'taxi', 'drive'];
const TRANSFER_LEGS: readonly ItineraryTransferLeg[] = [
	'transferToOriginAirport',
	'transferToHotel',
	'transferToConnectionAirport',
	'transferToDestinationLocation'
];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
	return allowed.find((candidate) => candidate === value);
}

function bed(value: unknown): SavedBed | undefined {
	if (!isRecord(value)) return undefined;
	const propertyName = text(value.propertyName);
	const roomKind = oneOf(ROOM_KINDS, value.roomKind);
	if (propertyName === undefined || roomKind === undefined) return undefined;
	// A rating that no longer parses drops the rating, never the bed. The property name is
	// what a row is for; the score is a decoration on it.
	const rating = isRecord(value.rating) ? value.rating : undefined;
	const ratingValue = rating ? count(rating.value) : undefined;
	const outOf = rating ? count(rating.outOf) : undefined;
	return {
		propertyName,
		roomKind,
		rating: ratingValue !== undefined && outOf !== undefined ? { value: ratingValue, outOf } : undefined
	};
}

function groundLegs(value: unknown): SavedGroundLeg[] {
	if (!Array.isArray(value)) return [];
	const legs: SavedGroundLeg[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const leg = oneOf(TRANSFER_LEGS, item.leg);
		const mode = oneOf(TRANSFER_MODES, item.mode);
		if (leg === undefined || mode === undefined) continue;
		legs.push({ leg, mode });
	}
	return legs;
}

function trip(value: unknown): SavedTrip | undefined {
	if (!isRecord(value)) return undefined;
	const origin = place(value.origin);
	const connection = place(value.connection);
	const destination = place(value.destination);
	const outboundFlight = flight(value.outboundFlight);
	const onwardFlight = flight(value.onwardFlight);
	const nightsInConnection = count(value.nightsInConnection);
	const travellers = count(value.travellers);
	if (origin === undefined || connection === undefined || destination === undefined) return undefined;
	if (outboundFlight === undefined || onwardFlight === undefined) return undefined;
	if (nightsInConnection === undefined || travellers === undefined) return undefined;
	return {
		origin,
		connection,
		destination,
		outboundFlight,
		onwardFlight,
		nightsInConnection,
		groundLegs: groundLegs(value.groundLegs),
		bed: bed(value.bed),
		travellers
	};
}

function observation(value: unknown): PriceObservation | undefined {
	if (!isRecord(value)) return undefined;
	const observedAt = count(value.observedAt);
	const visit = text(value.visit);
	const nights = count(value.nights);
	const total = money(value.total);
	if (observedAt === undefined || visit === undefined || nights === undefined) return undefined;
	if (total === undefined) return undefined;
	// A part that fails to parse comes back absent, which is what an absent part already
	// means here: nobody priced it. That is the honest reading of a half-written row, and
	// the alternative is dropping a total the traveller can still use.
	return {
		observedAt,
		visit,
		nights,
		flights: money(value.flights),
		bed: money(value.bed),
		ground: money(value.ground),
		total
	};
}

function observations(value: unknown): PriceObservation[] {
	if (!Array.isArray(value)) return [];
	const rows: PriceObservation[] = [];
	for (const item of value) {
		const row = observation(item);
		if (row) rows.push(row);
	}
	return capObservations(rows.sort((a, b) => a.observedAt - b.observedAt));
}

function entry(value: unknown): SavedItinerary | undefined {
	if (!isRecord(value)) return undefined;
	const id = text(value.id);
	const query = text(value.query);
	const savedAt = count(value.savedAt);
	const snapshot = trip(value.trip);
	if (id === undefined || query === undefined || savedAt === undefined || snapshot === undefined) {
		return undefined;
	}
	return { id, query, savedAt, trip: snapshot, prices: observations(value.prices) };
}

/** Never throws. A corrupt file, a half-written entry or a missing key all read as nothing
 * saved, for the reason this file's header gives. */
export function loadSavedItineraries(): SavedItinerary[] {
	const raw = readRaw();
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const entries: SavedItinerary[] = [];
		for (const item of parsed) {
			const saved = entry(item);
			if (saved) entries.push(saved);
		}
		return sortAndCap(entries);
	} catch {
		return [];
	}
}

export function writeSavedItineraries(entries: readonly SavedItinerary[]): boolean {
	try {
		return writeRaw(JSON.stringify(entries));
	} catch {
		return false;
	}
}

export function clearSavedItineraries(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to roll back to, and nothing the caller could do about it.
	}
}

function sortAndCap(entries: readonly SavedItinerary[]): SavedItinerary[] {
	return [...entries].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SAVED_ITINERARIES);
}

/** The newest observations, oldest first. The tail is what a chart and a "what does it cost
 * now" line both read, so the front is what falls off. */
function capObservations(prices: readonly PriceObservation[]): PriceObservation[] {
	return prices.length <= MAX_PRICE_OBSERVATIONS ? [...prices] : prices.slice(-MAX_PRICE_OBSERVATIONS);
}

/**
 * Adds a trip to the list, or leaves it exactly as it was if the same trip is already in
 * it.
 *
 * Idempotent on purpose. `savedAt` means the moment the traveller kept this trip and the
 * snapshot means the trip as it stood then, so a second save of the same id must not
 * rewrite either, and it must not touch the price log that has been accumulating under it.
 * The heart is a toggle; pressing it on something already saved is `forgetItinerary`'s job.
 */
export function saveItinerary(
	entries: readonly SavedItinerary[],
	saved: SavedItinerary
): SavedItinerary[] {
	if (entries.some((existing) => existing.id === saved.id)) return [...entries];
	return sortAndCap([saved, ...entries]);
}

export function forgetItinerary(
	entries: readonly SavedItinerary[],
	id: SavedItineraryId
): SavedItinerary[] {
	return entries.filter((existing) => existing.id !== id);
}

/**
 * Whether a row from this visit is already on top of the log.
 *
 * The owner: "only when user revisits the page we get a new price entry". A results page
 * re-renders whenever a snapshot lands, a filter moves or a night is added, and every one
 * of those would otherwise write a row. So the results page mints one `VisitToken` per
 * visit and hands it in with every observation, and this is the question that stops the
 * second write.
 *
 * The newest row only, not the whole log. A token is opaque and the caller owns what counts
 * as a visit; all this has to answer is "did the row I am about to write come from the same
 * visit as the row on top of the pile", which is exactly the re-render case.
 *
 * A named predicate rather than a check inside `appendObservation`, because the store asks
 * the same question one level up to avoid pricing a trip it is about to refuse, and two
 * spellings of one rule is how the two come to disagree.
 */
export function isRepeatVisit(prices: readonly PriceObservation[], visit: VisitToken): boolean {
	return prices.at(-1)?.visit === visit;
}

/** Files one price for one visit, and refuses a second one for the same visit. */
export function appendObservation(
	prices: readonly PriceObservation[],
	next: PriceObservation
): PriceObservation[] {
	if (isRepeatVisit(prices, next.visit)) return [...prices];
	return capObservations([...prices, next]);
}

/**
 * `appendObservation` applied to the one trip named. A trip that is not saved records
 * nothing: the log belongs to the heart, so a page re-pricing every card on screen can call
 * this for all of them and only the kept ones grow a row.
 */
export function recordPrice(
	entries: readonly SavedItinerary[],
	id: SavedItineraryId,
	next: PriceObservation
): SavedItinerary[] {
	return entries.map((existing) =>
		existing.id === id ? { ...existing, prices: appendObservation(existing.prices, next) } : existing
	);
}
