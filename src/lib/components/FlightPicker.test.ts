/**
 * Mounts the real component with Svelte 5's own `mount`/`unmount`/`flushSync` (see
 * vitest.config.ts's `resolve.conditions` comment for why that needs a `browser` condition
 * under Vitest) and asserts against the live DOM, the same approach the itinerary timeline
 * component uses elsewhere in this codebase. No new test-library dependency.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Airport, City, Country, Duration, FlightOffer, LocalDateTime, Stay } from '../domain';
import { buildItineraries, type BuildItinerariesInput } from '../algorithm/build';
import type { RecomputedSelection } from '../algorithm/recompute-selection';
import type { WidenOption } from '../search/types';
import FlightPicker from './FlightPicker.svelte';

const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string): Airport {
	return {
		iataCode,
		name: `${iataCode} airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country,
		sizeClass: 'medium'
	};
}

function localDateTime(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function makeFlight(
	flightNumber: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	duration: number,
	priceMinorUnits: number
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber,
		departureAirport: 'LGW',
		arrivalAirport: 'VIE',
		departure,
		arrival,
		duration: duration as Duration,
		price: { minorUnits: priceMinorUnits, currency: 'EUR' },
		priceScope: 'per-person',
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

function baseItinerary() {
	const origin = makeAirport('LGW');
	const connection = makeAirport('VIE');
	const destination = makeAirport('IST');
	const outboundArrival = localDateTime('2026-06-01T10:00:00');
	// A generous 90-minute base layover, so a "40 minutes later" alternative arrival still
	// clears the 30-minute default minimum layover in the delta test below, and the
	// separate too-tight test can shrink the gap on its own terms.
	const onwardDeparture = localDateTime('2026-06-01T11:30:00');
	const outbound = makeFlight('FR100', outboundArrival, outboundArrival, 150, 5000);
	const onward: FlightOffer = {
		...makeFlight('FR200', onwardDeparture, onwardDeparture, 90, 4000),
		departureAirport: 'VIE',
		arrivalAirport: 'IST'
	};
	const input: BuildItinerariesInput = {
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [outbound],
		onwardOffers: [onward],
		connectionAirports: { VIE: connection },
		connectionResources: {
			VIE: { stay: makeStay(), transferToHotel: { mode: 'walk', duration: 5 as Duration, legs: [] }, transferToConnectionAirport: { mode: 'walk', duration: 5 as Duration, legs: [] } }
		},
		waitingTimeRules: [{ waitingTime: 0 as Duration }]
	};
	const [itinerary] = buildItineraries(input);
	if (!itinerary) throw new Error('fixture itinerary failed to build');
	return itinerary;
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

function mountPicker(props: {
	itinerary: ReturnType<typeof baseItinerary>;
	alternatives: FlightOffer[];
	onselect: (result: RecomputedSelection) => void;
	widenOptions?: WidenOption[];
	onWiden?: (option: WidenOption) => void;
}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(FlightPicker, {
		target,
		props: {
			legLabel: 'Outbound: LGW to VIE',
			itinerary: props.itinerary,
			leg: 'outbound',
			alternatives: props.alternatives,
			onselect: props.onselect,
			widenOptions: props.widenOptions,
			onWiden: props.onWiden
		}
	});
	flushSync();
	return target;
}

describe('FlightPicker', () => {
	it('shows a signed delta for every alternative, not only an absolute price', () => {
		const itinerary = baseItinerary();
		const laterArrival = localDateTime('2026-06-01T10:40:00'); // 40 minutes after 10:00
		const alternative = makeFlight('FR101', laterArrival, laterArrival, 150, 6200);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const text = root.textContent ?? '';
		// +€12 exactly (6200 - 5000 = 1200 minor units) and 40 minutes later, per the
		// itinerary's own worked example.
		expect(text).toContain('+€12.00');
		expect(text).toContain('40m later');
	});

	it('flags an alternative that would break the minimum layover, before it is even selected', () => {
		const itinerary = baseItinerary();
		// Onward departs at 11:30; this alternative lands at 11:15, a 15-minute gap under
		// the 30-minute default minimum layover.
		const tooLate = localDateTime('2026-06-01T11:15:00');
		const alternative = makeFlight('FR102', tooLate, tooLate, 175, 5000);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		expect(root.textContent).toMatch(/below the 30-minute minimum layover/);
	});

	it('recomputes the whole itinerary and reports the warning when that alternative is picked', () => {
		const itinerary = baseItinerary();
		const tooLate = localDateTime('2026-06-01T11:15:00');
		const alternative = makeFlight('FR102', tooLate, tooLate, 175, 5000);

		let received: RecomputedSelection | undefined;
		const root = mountPicker({
			itinerary,
			alternatives: [alternative],
			onselect: (result) => {
				received = result;
			}
		});

		const radios = root.querySelectorAll('input[type="radio"]');
		// Two rows: the current pick and the one alternative, sorted by departure time
		// (10:00 then 11:15). The alternative is the second radio.
		expect(radios).toHaveLength(2);
		(radios[1] as HTMLInputElement).click();
		flushSync();

		expect(received).toBeDefined();
		expect(received?.itinerary.outboundFlight.flightNumber).toBe('FR102');
		expect(received?.warnings.map((warning) => warning.code)).toContain('layover-too-short');
	});

	it('marks the current pick and never shows it as an alternative with its own delta', () => {
		const itinerary = baseItinerary();
		const root = mountPicker({ itinerary, alternatives: [], onselect: () => {} });

		expect(root.textContent).toContain('Current pick');
	});
});

describe('FlightPicker: widen options (issue #56 cost awareness)', () => {
	it('shows the request cost for a calendar-tier widen before the traveller commits to it', () => {
		const itinerary = baseItinerary();
		const calendarOption: WidenOption = {
			providerId: 'flights-sky',
			kind: 'flight',
			tier: 'calendar',
			label: 'Flights Sky',
			candidateAirportCode: 'VIE',
			requests: 1,
			requiresKey: false
		};

		const root = mountPicker({
			itinerary,
			alternatives: [],
			onselect: () => {},
			widenOptions: [calendarOption]
		});

		const text = root.textContent ?? '';
		expect(text).toContain('Flights Sky: check cheaper dates');
		expect(text).toContain('~1 request');
	});

	it('gives a confirm-tier widen a visibly different treatment from a calendar-tier one', () => {
		const itinerary = baseItinerary();
		const options: WidenOption[] = [
			{
				providerId: 'flights-sky',
				kind: 'flight',
				tier: 'calendar',
				label: 'Flights Sky',
				candidateAirportCode: 'VIE',
				requests: 1,
				requiresKey: false
			},
			{
				providerId: 'skyscanner',
				kind: 'flight',
				tier: 'confirm',
				label: 'Skyscanner',
				candidateAirportCode: 'VIE',
				requests: 12,
				requiresKey: false
			}
		];

		const root = mountPicker({ itinerary, alternatives: [], onselect: () => {}, widenOptions: options });

		const calendarButton = root.querySelector('.widen-option-calendar');
		const confirmButton = root.querySelector('.widen-option-confirm');
		expect(calendarButton).toBeTruthy();
		expect(confirmButton).toBeTruthy();
		expect(calendarButton?.className).not.toBe(confirmButton?.className);
		expect(confirmButton?.textContent).toContain('~12 requests');
	});

	it('disables an option that needs a key instead of a request count, and never calls onWiden for it', () => {
		const itinerary = baseItinerary();
		const option: WidenOption = {
			providerId: 'skyscanner',
			kind: 'flight',
			tier: 'confirm',
			label: 'Skyscanner',
			candidateAirportCode: 'VIE',
			requests: 12,
			requiresKey: true
		};

		let called = false;
		const root = mountPicker({
			itinerary,
			alternatives: [],
			onselect: () => {},
			widenOptions: [option],
			onWiden: () => {
				called = true;
			}
		});

		const button = root.querySelector<HTMLButtonElement>('.widen-option');
		expect(button?.disabled).toBe(true);
		expect(button?.textContent).toContain('needs a key');
		button?.click();
		flushSync();
		expect(called).toBe(false);
	});

	it('reports which option was picked without spending it itself', () => {
		const itinerary = baseItinerary();
		const option: WidenOption = {
			providerId: 'flights-sky',
			kind: 'flight',
			tier: 'calendar',
			label: 'Flights Sky',
			candidateAirportCode: 'VIE',
			requests: 1,
			requiresKey: false
		};

		let received: WidenOption | undefined;
		const root = mountPicker({
			itinerary,
			alternatives: [],
			onselect: () => {},
			widenOptions: [option],
			onWiden: (picked) => {
				received = picked;
			}
		});

		root.querySelector<HTMLButtonElement>('.widen-option')?.click();
		flushSync();

		expect(received).toEqual(option);
	});

	it('hides a widen option scoped to a different connection candidate', () => {
		const itinerary = baseItinerary();
		const option: WidenOption = {
			providerId: 'flights-sky',
			kind: 'flight',
			tier: 'calendar',
			label: 'Flights Sky',
			candidateAirportCode: 'MXP', // a different stopover, not this itinerary's VIE
			requests: 1,
			requiresKey: false
		};

		const root = mountPicker({ itinerary, alternatives: [], onselect: () => {}, widenOptions: [option] });

		expect(root.querySelector('.widen-options')).toBeNull();
	});

	it('ignores a widen option for a different provider kind (e.g. a stay)', () => {
		const itinerary = baseItinerary();
		const option: WidenOption = {
			providerId: 'agoda',
			kind: 'stay',
			tier: 'confirm',
			label: 'Agoda',
			candidateAirportCode: 'VIE',
			requests: 3,
			requiresKey: false
		};

		const root = mountPicker({ itinerary, alternatives: [], onselect: () => {}, widenOptions: [option] });

		expect(root.querySelector('.widen-options')).toBeNull();
	});
});
