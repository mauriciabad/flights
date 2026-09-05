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

	it('never prints a negative duration on a row whose flights are in the wrong order', () => {
		// Issue #247, off production: "Only -3230 minutes between the flights, below the
		// 30-minute minimum layover." Onward departs 11:30 on 1 June; this alternative lands
		// two days later, so there is no layover to be short.
		const itinerary = baseItinerary();
		const daysLate = localDateTime('2026-06-03T11:15:00');
		const alternative = makeFlight('FR103', daysLate, daysLate, 175, 5000);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const text = root.textContent ?? '';
		expect(text).toContain('The onward flight leaves before this one lands');
		expect(text).not.toMatch(/minimum layover/);
		expect(text).not.toMatch(/-\d+ minute/);
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

/**
 * Issue #317, measured on production at 1280x900 on
 * `flights.mauri.app/results/?arr=2026-10-12&dep=2026-10-06&from=BCN&to=PFO`: thirteen rows
 * over four dates, and not one of them printed a date. The same flight number, VY6500 at
 * 7:20am, appeared four times at EUR 55, 41, 67 and 82, and the only thing separating those
 * rows was a relative offset buried at the end of each one ("23h earlier", "49h later").
 */
describe('FlightPicker: which day a row is on (issue #317)', () => {
	it('stamps every row with its departure date once the list crosses a day boundary', () => {
		const itinerary = baseItinerary();
		// Two days after the 1 June pick, which is the shape production had: the same clock
		// reading on a different date.
		const nextDay = localDateTime('2026-06-02T10:00:00');
		const alternative = makeFlight('FR104', nextDay, nextDay, 150, 5000);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const dates = [...root.querySelectorAll('.row-date')].map((node) => node.textContent?.trim());
		expect(dates).toEqual(['Mon 1', 'Tue 2']);
	});

	it('says nothing about dates when every row is on the same day', () => {
		const itinerary = baseItinerary();
		const sameDay = localDateTime('2026-06-01T10:40:00');
		const alternative = makeFlight('FR105', sameDay, sameDay, 150, 6200);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		expect(root.querySelectorAll('.row-date')).toHaveLength(0);
	});

	it('stamps an arrival that lands on a later date than its own departure', () => {
		const itinerary = baseItinerary();
		const lateDeparture = localDateTime('2026-06-02T23:30:00');
		const nextMorning = localDateTime('2026-06-03T01:30:00');
		const alternative = makeFlight('FR106', lateDeparture, nextMorning, 120, 5000);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const rows = root.querySelectorAll('.picker-row');
		expect(rows[1]?.querySelector('.tl-note-plusday')?.textContent).toContain('+1');
		expect(rows[0]?.querySelector('.tl-note-plusday')).toBeNull();
	});
});

/**
 * Issue #317's second half. Production printed "+EUR 200.01 . 53h 10m later" on a row whose
 * own next line read "The onward flight leaves before this one lands, so there is no
 * connection to make." Six of the thirteen rows were priced that way.
 *
 * Prompt 007 settled the principle on a different absurd option, an eleven-hour walk priced
 * at zero: "dont even show this", because "it makes the panel look unserious and buries the
 * real choices".
 */
describe('FlightPicker: what an unusable row may claim (issue #317)', () => {
	function rowWithNoConnection() {
		const itinerary = baseItinerary();
		// Onward departs 11:30 on 1 June; this alternative lands two days later.
		const daysLate = localDateTime('2026-06-03T11:15:00');
		return { itinerary, alternative: makeFlight('FR107', daysLate, daysLate, 175, 7500) };
	}

	it('prices no row the app has already ruled out', () => {
		const { itinerary, alternative } = rowWithNoConnection();

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const ruledOut = [...root.querySelectorAll('.picker-row')].find((row) =>
			row.textContent?.includes('no connection to make')
		);
		expect(ruledOut).toBeDefined();
		expect(ruledOut?.querySelector('.row-price')).toBeNull();
		expect(ruledOut?.querySelector('.delta-text')).toBeNull();
		expect(ruledOut?.textContent).not.toMatch(/€/);
	});

	it('greys the row rather than deleting it, so the flight is still known to exist', () => {
		const { itinerary, alternative } = rowWithNoConnection();

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const ruledOut = [...root.querySelectorAll('.picker-row')].find((row) =>
			row.textContent?.includes('no connection to make')
		);
		expect(ruledOut?.className).toContain('is-unusable');
		expect(ruledOut?.textContent).toContain('FR107');
		// Still selectable. AGENTS.md leaves an impossible pick with the traveller rather
		// than blocking it, and the onward leg is what they would change next.
		expect(ruledOut?.querySelector('input[type="radio"]')).not.toBeNull();
	});

	it('keeps the price and the delta on a tight layover, which is a trip you can still take', () => {
		const itinerary = baseItinerary();
		// A 15-minute gap: under the traveller's own 30-minute minimum, above zero.
		const tight = localDateTime('2026-06-01T11:15:00');
		const alternative = makeFlight('FR108', tight, tight, 175, 6200);

		const root = mountPicker({ itinerary, alternatives: [alternative], onselect: () => {} });

		const warned = [...root.querySelectorAll('.picker-row')].find((row) =>
			row.textContent?.includes('minimum layover')
		);
		expect(warned?.querySelector('.row-price')).not.toBeNull();
		expect(warned?.querySelector('.delta-text')?.textContent).toContain('+€12.00');
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
