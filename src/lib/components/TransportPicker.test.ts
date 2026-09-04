import { describe, expect, it, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Airport, City, Country, Duration, FlightOffer, Itinerary, LocalDateTime, Stay, Transfer } from '../domain';
import { buildItineraries, type BuildItinerariesInput } from '../algorithm/build';
import type { RecomputedSelection } from '../algorithm/recompute-selection';
import type { TaxiFareEstimate } from '../providers/transfers/taxi-rate-table';
import TransportPicker from './TransportPicker.svelte';

const country: Country = { isoCode: 'FR', name: 'France' };
const city: City = { name: 'Paris', coordinates: { latitude: 48.85, longitude: 2.35 }, country };

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
	return { local, timeZone: 'Europe/Paris', utcOffsetMinutes: 60 };
}

function makeFlight(departure: LocalDateTime, arrival: LocalDateTime): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR100',
		departureAirport: 'LGW',
		arrivalAirport: 'CDG',
		departure,
		arrival,
		duration: 120 as Duration,
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

/** One itinerary landing at 01:00, well past any realistic last bus, so the transport
 * picker's "no service" framing has a real gap to describe. */
function baseItinerary(transferToHotel: Transfer): Itinerary {
	const origin = makeAirport('LGW');
	const connection = makeAirport('CDG');
	const destination = makeAirport('IST');
	const outboundArrival = localDateTime('2026-06-01T01:00:00');
	const onwardDeparture = localDateTime('2026-06-02T14:00:00');
	const outbound = makeFlight(outboundArrival, outboundArrival);
	const onward: FlightOffer = { ...makeFlight(onwardDeparture, onwardDeparture), departureAirport: 'CDG', arrivalAirport: 'IST' };

	const input: BuildItinerariesInput = {
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [outbound],
		onwardOffers: [onward],
		connectionAirports: { CDG: connection },
		connectionResources: {
			CDG: {
				stay: makeStay(),
				transferToHotel,
				transferToConnectionAirport: { mode: 'walk', duration: 10 as Duration, legs: [] }
			}
		},
		waitingTimeRules: [{ waitingTime: 0 as Duration }]
	};
	const [itinerary] = buildItineraries(input);
	if (!itinerary) throw new Error('fixture itinerary failed to build');
	return itinerary;
}

/** Collapses the template's own authored whitespace and indentation (line breaks between
 * an element's text and an interpolated expression on the next source line) so assertions
 * compare words, not incidental formatting. */
function normalizedText(element: HTMLElement): string {
	return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
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
	itinerary: Itinerary;
	alternatives: Transfer[];
	taxiFareEstimate?: TaxiFareEstimate;
	referenceMoment?: LocalDateTime;
	onselect?: (result: RecomputedSelection) => void;
}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(TransportPicker, {
		target,
		props: {
			legLabel: 'Connection airport to hotel',
			itinerary: props.itinerary,
			legField: 'transferToHotel',
			alternatives: props.alternatives,
			taxiFareEstimate: props.taxiFareEstimate,
			referenceMoment: props.referenceMoment,
			referenceLabel: 'you land',
			onselect: props.onselect ?? (() => {})
		}
	});
	flushSync();
	return target;
}

describe('TransportPicker: no-service transit', () => {
	it('renders the gap and the next departure, never an empty state, when transit stopped for the night', () => {
		const walkTransfer: Transfer = { mode: 'walk', duration: 40 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);

		// The traveller lands at 01:00; the last bus already left, and the next one departs
		// at 05:20 with nothing scheduled after it today (the last-bus problem, issue #8).
		const transit: Transfer = {
			mode: 'transit',
			duration: 25 as Duration,
			legs: [{ mode: 'transit', description: 'Bus 100 to City Airport Station', duration: 25 as Duration }],
			transitSchedule: { intended: localDateTime('2026-06-01T05:20:00'), following: [] }
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).toContain('No public transport until 05:20');
		expect(text).toContain('4h 20m after you land');
		// Not an empty state: the row still renders with its own duration and schedule.
		expect(text).toContain('25m');
	});

	it('offers the taxi and its estimate alongside a no-service transit result', () => {
		const walkTransfer: Transfer = { mode: 'walk', duration: 40 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);
		const transit: Transfer = {
			mode: 'transit',
			duration: 25 as Duration,
			legs: [],
			transitSchedule: { intended: localDateTime('2026-06-01T05:20:00'), following: [] }
		};
		const taxi: Transfer = { mode: 'taxi', duration: 18 as Duration, legs: [] };
		const taxiFareEstimate: TaxiFareEstimate = {
			kind: 'estimate',
			currency: 'EUR',
			lowMinorUnits: 1800,
			highMinorUnits: 2400,
			countryCode: 'FR',
			rateSource: 'country',
			citation: 'French national per-km ceiling, service-public.gouv.fr'
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit, taxi],
			taxiFareEstimate,
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).toContain('A taxi now takes about 18m and costs roughly €18.00-€24.00');
		expect(text).toContain('estimate');
		expect(text).toContain('French national per-km ceiling');
	});

	it('does not use the dramatic gap framing for a normal, imminent departure', () => {
		const walkTransfer: Transfer = { mode: 'walk', duration: 5 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);
		const transit: Transfer = {
			mode: 'transit',
			duration: 15 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T01:05:00'),
				following: [localDateTime('2026-06-01T01:20:00'), localDateTime('2026-06-01T01:35:00')]
			}
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).not.toContain('No public transport until');
		expect(text).toContain('Departs 01:05');
		expect(text).toContain('Next: 01:20, 01:35');
	});
});

describe('TransportPicker: mode breakdown', () => {
	it('shows every leg of a multi-leg transfer, not only its total duration', () => {
		const walkTransfer: Transfer = { mode: 'walk', duration: 5 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);
		const multiLeg: Transfer = {
			mode: 'transit',
			duration: 45 as Duration,
			legs: [
				{ mode: 'walk', description: 'Walk to the station', duration: 10 as Duration },
				{ mode: 'transit', description: 'Train to City Centre', duration: 35 as Duration }
			],
			transitSchedule: { intended: localDateTime('2026-06-01T01:10:00'), following: [] }
		};

		const root = mountPicker({ itinerary, alternatives: [multiLeg] });

		const text = normalizedText(root);
		expect(text).toContain('Walk to the station (10m)');
		expect(text).toContain('Train to City Centre (35m)');
	});
});

describe('TransportPicker: selection', () => {
	it('recomputes the itinerary and invokes onselect with the chosen transfer', () => {
		const currentTransfer: Transfer = { mode: 'walk', duration: 30 as Duration, legs: [] };
		const itinerary = baseItinerary(currentTransfer);
		const taxi: Transfer = { mode: 'taxi', duration: 12 as Duration, legs: [] };

		let received: RecomputedSelection | undefined;
		const root = mountPicker({
			itinerary,
			alternatives: [taxi],
			onselect: (result) => {
				received = result;
			}
		});

		const radios = root.querySelectorAll('input[type="radio"]');
		expect(radios.length).toBeGreaterThanOrEqual(2);
		const taxiRadio = [...radios].find((radio) => !(radio as HTMLInputElement).checked);
		(taxiRadio as HTMLInputElement).click();
		flushSync();

		expect(received).toBeDefined();
		expect(received?.itinerary.transferToHotel?.mode).toBe('taxi');
	});

	it('never selects a row just because the traveller expanded its taxi citation', () => {
		// The citation <details> lives inside the row's <label> (the label is what makes the
		// whole row clickable). A <label> re-fires a click on its associated <input> for any
		// bubbled click that is not itself a form control, and <summary> is not exempted the
		// way <input>/<button> are, so without stopPropagation on the summary, opening the
		// citation would silently select the taxi row underneath it.
		const currentTransfer: Transfer = { mode: 'walk', duration: 30 as Duration, legs: [] };
		const itinerary = baseItinerary(currentTransfer);
		const taxi: Transfer = { mode: 'taxi', duration: 12 as Duration, legs: [] };
		const taxiFareEstimate: TaxiFareEstimate = {
			kind: 'estimate',
			currency: 'EUR',
			lowMinorUnits: 1200,
			highMinorUnits: 1800,
			countryCode: 'FR',
			rateSource: 'country',
			citation: 'Test citation'
		};

		let selectCount = 0;
		const root = mountPicker({
			itinerary,
			alternatives: [taxi],
			taxiFareEstimate,
			onselect: () => {
				selectCount += 1;
			}
		});

		const summary = root.querySelector<HTMLElement>('.taxi-citation summary');
		expect(summary).toBeTruthy();
		summary?.click();
		flushSync();

		const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
		const stillCheckedRadio = radios.find((radio) => radio.checked);
		expect(stillCheckedRadio?.closest('.picker-row')?.querySelector('.row-mode-label')?.textContent).toBe(
			'Walk'
		);
		expect(selectCount).toBe(0); // opening the citation must never fire onselect
		expect(root.querySelector('.taxi-citation')?.hasAttribute('open')).toBe(true); // it did open
	});
});
