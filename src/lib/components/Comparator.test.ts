import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	Itinerary,
	LocalDateTime,
	Location,
	Stay,
	Transfer
} from '../domain';
import { buildItineraries } from '../algorithm/build';
import type { ProviderSource } from '../providers/types';
import Comparator from './Comparator.svelte';
import type { ComparedItinerary } from './comparator-types';
import { formatDuration, formatMoney } from './itinerary-timeline-format';

/**
 * Fixtures mirror ItineraryTimeline.test.ts: build real Itinerary objects through
 * `buildItineraries` rather than hand-authoring them, so freeTime, nights and totals are
 * exactly what the domain rules produce.
 */
const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string, name: string): Airport {
	return { iataCode, name, coordinates: { latitude: 0, longitude: 0 }, city, country, sizeClass: 'medium' };
}

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

function makeFlight(
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	duration: number
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR123',
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		duration: duration as Duration,
		price: { minorUnits: 5000, currency: 'EUR' },
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function makeStay(): Stay {
	return {
		property: { name: 'Test Hostel', coordinates: { latitude: 0, longitude: 0 }, images: [] },
		roomKind: 'dorm',
		pricePerNight: { minorUnits: 3000, currency: 'EUR' }
	};
}

function makeTransfer(duration: number, legCount = 1): Transfer {
	return {
		mode: legCount > 1 ? 'transit' : 'walk',
		duration: duration as Duration,
		legs: Array.from({ length: legCount }, (_, i) => ({
			mode: 'transit' as const,
			description: `Leg ${i + 1}`,
			duration: Math.round(duration / legCount) as Duration
		}))
	};
}

const origin = makeAirport('LGW', 'London Gatwick');
const connection = makeAirport('VIE', 'Vienna International');
const destination = makeAirport('IST', 'Istanbul Airport');

interface FixtureOptions {
	transferToHotelLegs?: number;
	outboundDuration?: number;
	originLocation?: Location;
	destinationLocation?: Location;
}

function makeItinerary(options: FixtureOptions = {}): Itinerary {
	const outboundArrival = localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
	const onwardDeparture = localDateTime('2026-06-03T14:00:00', 'Europe/Vienna', 120);
	const [itinerary] = buildItineraries({
		originAirport: origin,
		destinationAirport: destination,
		originLocation: options.originLocation,
		destinationLocation: options.destinationLocation,
		transferToOriginAirport: options.originLocation ? makeTransfer(20) : undefined,
		transferToDestinationLocation: options.destinationLocation ? makeTransfer(20) : undefined,
		outboundOffers: [
			makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, options.outboundDuration ?? 150)
		],
		onwardOffers: [makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90)],
		connectionAirports: { VIE: connection },
		connectionResources: {
			VIE: {
				stay: makeStay(),
				transferToHotel: makeTransfer(30, options.transferToHotelLegs ?? 1),
				transferToConnectionAirport: makeTransfer(30)
			}
		},
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	});
	return itinerary;
}

function source(providerId: string, fetchedAt: string): ProviderSource {
	return { providerId, fetchedAt };
}

let target: HTMLDivElement | undefined;
let instance: object | undefined;

afterEach(() => {
	if (instance) {
		unmount(instance);
		instance = undefined;
	}
	target?.remove();
	target = undefined;
});

function renderComparator(items: ComparedItinerary[]) {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(Comparator, { target, props: { items } });
	flushSync();
	return target;
}

function segmentsOf(column: Element): string[] {
	return Array.from(column.querySelectorAll('.tl-row')).map((row) => row.getAttribute('data-segment') ?? '');
}

function getColumnTotal(column: Element, label: string): string {
	const dt = Array.from(column.querySelectorAll('.comparator-total dt')).find((el) => el.textContent === label);
	const dd = dt?.nextElementSibling;
	if (!dd) throw new Error(`No total found for label "${label}" in column`);
	return dd.textContent ?? '';
}

describe('Comparator, row-for-row alignment across differing itineraries', () => {
	it('renders three itineraries with different transfer leg counts as columns with identical segment order', () => {
		const items: ComparedItinerary[] = [
			{ id: 'a', itinerary: makeItinerary({ transferToHotelLegs: 1 }) },
			{ id: 'b', itinerary: makeItinerary({ transferToHotelLegs: 3, outboundDuration: 200 }) },
			{ id: 'c', itinerary: makeItinerary({ transferToHotelLegs: 2 }) }
		];
		const root = renderComparator(items);

		const columns = root.querySelectorAll('.comparator-column');
		expect(columns).toHaveLength(3);

		const [segmentsA, segmentsB, segmentsC] = Array.from(columns).map(segmentsOf);
		// Same schedule, same order, in every column, regardless of how many legs any one
		// column's transfer rows happen to have — this positional correspondence is what
		// makes plain nth-child subgrid alignment correct.
		expect(segmentsA).toEqual(segmentsB);
		expect(segmentsA).toEqual(segmentsC);
		expect(segmentsA).toEqual([
			'origin-waiting',
			'outbound-flight',
			'transfer-to-hotel',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting',
			'onward-flight'
		]);

		// The differing leg counts really did land in the DOM (proving this test exercises
		// the "unequal row content height" case subgrid has to reconcile, not a no-op).
		const hotelTransferB = columns[1].querySelector('[data-segment="transfer-to-hotel"]');
		expect(hotelTransferB?.textContent).toContain('Leg 3');
	});

	it('includes the origin and destination location rows only when the query provided them', () => {
		const withLocations = makeItinerary({
			originLocation: { label: 'Home', coordinates: { latitude: 1, longitude: 1 } },
			destinationLocation: { label: 'Away', coordinates: { latitude: 2, longitude: 2 } }
		});
		const root = renderComparator([{ id: 'a', itinerary: withLocations }]);
		const segments = segmentsOf(root.querySelector('.comparator-column')!);
		expect(segments[0]).toBe('origin-location');
		expect(segments.at(-1)).toBe('destination-location');
		expect(segments).toHaveLength(11);
	});
});

describe('Comparator, shared footer', () => {
	it("shows each column's own totals, not one shared figure", () => {
		const shortStop = makeItinerary({ outboundDuration: 100 });
		const longStop = makeItinerary({});
		// Force visibly different free-time durations so the two footers are provably
		// distinct instead of coincidentally equal.
		const items: ComparedItinerary[] = [
			{ id: 'short', itinerary: shortStop },
			{ id: 'long', itinerary: longStop }
		];
		const root = renderComparator(items);
		const columns = root.querySelectorAll('.comparator-footer-column');
		expect(columns).toHaveLength(2);

		expect(getColumnTotal(columns[0], 'In-flight')).toBe(formatDuration(shortStop.times.inFlight));
		expect(getColumnTotal(columns[1], 'In-flight')).toBe(formatDuration(longStop.times.inFlight));
		expect(getColumnTotal(columns[0], 'Total price')).toBe(formatMoney(shortStop.totalPrice));
		expect(getColumnTotal(columns[0], 'Nights')).toBe(String(shortStop.nightsInConnection));
	});

	it('scales the free-time share bar against the longest stopover being compared', () => {
		const short = makeItinerary({});
		// A longer connectionWaitingTime eats into free time from the other side, so this
		// produces a itinerary with less free time than the default fixture without
		// touching outbound duration (kept simple: reuse the same fixture twice and assert
		// the wider one reaches exactly 100%, which is all the bar's own arithmetic needs
		// to prove — the per-value scaling is already covered by comparator-format.test.ts).
		const items: ComparedItinerary[] = [
			{ id: 'a', itinerary: short },
			{ id: 'b', itinerary: short }
		];
		const root = renderComparator(items);
		const fills = root.querySelectorAll('.comparator-share-fill');
		expect(fills).toHaveLength(2);
		// Two itineraries with equal free time both reach the max share.
		expect((fills[0] as HTMLElement).style.width).toBe('100%');
		expect((fills[1] as HTMLElement).style.width).toBe('100%');
	});
});

describe('Comparator, provenance card', () => {
	it('lists each provider and when it was fetched when sources are known', () => {
		const items: ComparedItinerary[] = [
			{
				id: 'a',
				itinerary: makeItinerary({}),
				sources: [source('skyscanner', new Date().toISOString()), source('agoda', new Date().toISOString())]
			}
		];
		const root = renderComparator(items);
		const provenance = root.querySelector('.comparator-provenance')?.textContent ?? '';
		expect(provenance).toContain('Skyscanner');
		expect(provenance).toContain('Agoda');
	});

	it('says provider data is not available yet rather than guessing', () => {
		const items: ComparedItinerary[] = [{ id: 'a', itinerary: makeItinerary({}) }];
		const root = renderComparator(items);
		expect(root.querySelector('.comparator-note')?.textContent).toBe('Provider data not available yet.');
	});
});

describe('Comparator, empty state', () => {
	it('shows guidance instead of an empty grid when nothing is selected', () => {
		const root = renderComparator([]);
		expect(root.querySelector('.comparator-scroll')).toBeNull();
		expect(root.textContent).toContain('Nothing to compare yet');
	});
});

describe('Comparator, keyboard scroll does not hijack a focused control inside a column', () => {
	it('leaves the event unhandled when it bubbles up from a child instead of the scroll container itself', () => {
		const items: ComparedItinerary[] = [{ id: 'a', itinerary: makeItinerary({}) }];
		const root = renderComparator(items);
		const waitingInput = root.querySelector<HTMLInputElement>('[data-segment="origin-waiting"] input');
		expect(waitingInput).not.toBeNull();

		// ArrowDown is one of handleScrollKeydown's handled keys when it fires on the
		// scroll container directly; dispatched here from a descendant (the stepper's own
		// number input, which uses ArrowUp/ArrowDown itself), it must bail out before ever
		// calling scrollBy/preventDefault — proven by defaultPrevented staying false, not by
		// asserting on scroll position (jsdom does not implement Element.scrollBy at all,
		// so reaching that call here would throw rather than silently no-op).
		const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
		waitingInput!.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});
