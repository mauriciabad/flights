import { describe, expect, it, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type {
	Airport,
	City,
	Country,
	Duration,
	FlightOffer,
	Itinerary,
	LocalDateTime,
	Stay,
	Transfer,
	TransitPlanMoment
} from '../domain';
import { buildItineraries, type BuildItinerariesInput } from '../algorithm/build';
import type { RecomputedSelection } from '../algorithm/recompute-selection';
import type { FareEstimate } from '../domain';
import type { TransitLegAnswer } from '../search/types';
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

/** Issue #135: the journey moment a schedule was planned for. `departAfter` is the
 * leg-starts-at-a-runway question; `arriveByDeadline` the leg-ends-at-a-gate one. */
function departAfter(local: string): TransitPlanMoment {
	return { time: localDateTime(local), arriveBy: false };
}

function arriveByDeadline(local: string): TransitPlanMoment {
	return { time: localDateTime(local), arriveBy: true };
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
	referenceMoment?: LocalDateTime;
	transitAnswer?: TransitLegAnswer;
	oncheckTransit?: () => void;
	transitChecking?: boolean;
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
			referenceMoment: props.referenceMoment,
			referenceLabel: 'you land',
			transitAnswer: props.transitAnswer,
			oncheckTransit: props.oncheckTransit,
			transitChecking: props.transitChecking,
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
			transitSchedule: { intended: localDateTime('2026-06-01T05:20:00'), following: [], plannedFor: departAfter('2026-06-01T01:00:00') }
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).toContain('No public transport until 5:20am');
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
			transitSchedule: { intended: localDateTime('2026-06-01T05:20:00'), following: [], plannedFor: departAfter('2026-06-01T01:00:00') }
		};
		const taxi: Transfer = { mode: 'taxi', duration: 18 as Duration, legs: [] };
		const taxiFareEstimate: FareEstimate = {
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
			alternatives: [transit, { ...taxi, fareEstimate: taxiFareEstimate }],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).toContain('A taxi now takes about 18m and costs roughly €18.00-€24.00');
		expect(text).toContain('estimate');
		expect(text).toContain('French national per-km ceiling');
	});

	it('says how long the ride is and that nobody priced it, when the rate card will not reach', () => {
		// Issue #246: production showed "Taxi 1h 17m £274.06-£439.44 ESTIMATE" for a 95 km
		// airport run, more than twice the €173.00 flight it connects to. The duration is
		// real and stays; the fare is a number this app has no basis for and goes.
		const walkTransfer: Transfer = { mode: 'walk', duration: 40 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);
		const taxi: Transfer = { mode: 'taxi', duration: 76 as Duration, legs: [] };
		const taxiFareEstimate: FareEstimate = {
			kind: 'out-of-range',
			distanceKm: 94.9,
			ratedUpToKm: 30,
			countryCode: 'GB',
			citation: 'Back-calculated from a London 5km fare comparison of roughly $23.'
		};

		const root = mountPicker({ itinerary, alternatives: [{ ...taxi, fareEstimate: taxiFareEstimate }] });

		const text = normalizedText(root);
		expect(text).toContain('1h 16m');
		expect(text).toContain('No fare estimate');
		expect(text).toContain('95 km');

		// Scoped to the price cell rather than the whole row: the citation quotes its own
		// source, "roughly $23 for 5 km in London", and that figure is evidence about the
		// card, not a fare this app is putting on this ride.
		const taxiRow = [...root.querySelectorAll('.picker-row')].find((row) =>
			row.querySelector('.row-mode-label')?.textContent?.includes('Taxi')
		);
		const priceCell = taxiRow?.querySelector('.row-price')?.textContent ?? '';
		expect(priceCell).toContain('No fare estimate');
		expect(priceCell).not.toMatch(/[£€$]/);
		expect(priceCell).not.toMatch(/\d/);
	});

	it('offers the taxi against a dead timetable without pretending to know the fare', () => {
		// The other surface the estimate reaches, and the one the issue quoted: "A taxi now
		// takes about 1h 46m and costs roughly £268.75-£430.90." The taxi is still the answer
		// to "there is no bus for four hours"; what it costs is the half nobody measured.
		const walkTransfer: Transfer = { mode: 'walk', duration: 40 as Duration, legs: [] };
		const itinerary = baseItinerary(walkTransfer);
		const transit: Transfer = {
			mode: 'transit',
			duration: 25 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T05:20:00'),
				following: [],
				plannedFor: departAfter('2026-06-01T01:00:00')
			}
		};
		const taxi: Transfer = { mode: 'taxi', duration: 76 as Duration, legs: [] };
		const taxiFareEstimate: FareEstimate = {
			kind: 'out-of-range',
			distanceKm: 94.9,
			ratedUpToKm: 30,
			countryCode: 'GB',
			citation: 'Back-calculated from a London 5km fare comparison of roughly $23.'
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit, { ...taxi, fareEstimate: taxiFareEstimate }],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const gapLine = root.querySelector('.schedule-gap-alternative')?.textContent ?? '';
		expect(gapLine.replace(/\s+/g, ' ').trim()).toBe(
			'A taxi now takes about 1h 16m over 95 km. No rate card here reaches that far, so the fare is unknown.'
		);
		expect(gapLine).not.toContain('costs roughly');
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
				following: [localDateTime('2026-06-01T01:20:00'), localDateTime('2026-06-01T01:35:00')],
				plannedFor: departAfter('2026-06-01T01:00:00')
			}
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit],
			referenceMoment: localDateTime('2026-06-01T01:00:00')
		});

		const text = normalizedText(root);
		expect(text).not.toContain('No public transport until');
		expect(text).toContain('Departs 1:05am');
		expect(text).toContain('Next: 1:20am, 1:35am');
	});
});

describe('TransportPicker: mode breakdown', () => {
	const walkTransfer: Transfer = { mode: 'walk', duration: 5 as Duration, legs: [] };

	function multiLeg(): Transfer {
		return {
			mode: 'transit',
			duration: 45 as Duration,
			legs: [
				{ mode: 'walk', description: 'Walk to the station', duration: 10 as Duration },
				{ mode: 'transit', description: 'Train to City Centre', vehicle: 'Train', duration: 25 as Duration },
				{ mode: 'walk', description: 'Walk (280 m)', duration: 4 as Duration },
				{ mode: 'transit', description: 'Bus 46 to Aeroport', vehicle: 'Bus', duration: 6 as Duration }
			],
			transitSchedule: { intended: localDateTime('2026-06-01T01:10:00'), following: [], plannedFor: departAfter('2026-06-01T01:00:00') }
		};
	}

	it('shows every leg of a multi-leg transfer, not only its total duration', () => {
		const root = mountPicker({ itinerary: baseItinerary(walkTransfer), alternatives: [multiLeg()] });

		const text = normalizedText(root);
		expect(text).toContain('Walk to the station');
		expect(text).toContain('Train to City Centre');
		expect(text).toContain('Bus 46 to Aeroport');
	});

	it('names the vehicles and the changes in one line, instead of a brick of legs (issue #220)', () => {
		const root = mountPicker({ itinerary: baseItinerary(walkTransfer), alternatives: [multiLeg()] });

		// The owner's report: "a brick of unformated text that is impossible to understand".
		// The row itself now says what you ride and how often you change; the legs are behind
		// the disclosure below it.
		expect(normalizedText(root)).toContain('Train, then bus (1 change)');
	});

	it('puts the step list behind a disclosure rather than printing it on every row', () => {
		const root = mountPicker({ itinerary: baseItinerary(walkTransfer), alternatives: [multiLeg()] });

		const details = root.querySelector('details.row-steps');
		expect(details).not.toBeNull();
		expect((details as HTMLDetailsElement).open).toBe(false);
		expect(details?.querySelector('summary')?.textContent?.trim()).toBe('4 steps');
		expect(details?.querySelectorAll('li.step')).toHaveLength(4);
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
		const taxiFareEstimate: FareEstimate = {
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
			alternatives: [{ ...taxi, fareEstimate: taxiFareEstimate }],
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
		// Trimmed: since issue #119 the label is a `ModeIcon` and the word, so the text node
		// carries the whitespace between them.
		expect(
			stillCheckedRadio?.closest('.picker-row')?.querySelector('.row-mode-label')?.textContent?.trim()
		).toBe('Walk');
		expect(selectCount).toBe(0); // opening the citation must never fire onselect
		expect(root.querySelector('.taxi-citation')?.hasAttribute('open')).toBe(true); // it did open
	});
});

describe('TransportPicker: what missing it costs (issue #135)', () => {
	it('names the next departure and the gap when the last one of the night is missed', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 40 as Duration, legs: [] });
		// Lands 01:00, the 01:10 bus is the last of the night, the next is at 05:20.
		const transit: Transfer = {
			mode: 'transit',
			duration: 25 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T01:10:00'),
				following: [localDateTime('2026-06-01T05:20:00')],
				plannedFor: departAfter('2026-06-01T01:00:00')
			}
		};

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: [transit],
				referenceMoment: localDateTime('2026-06-01T01:00:00')
			})
		);

		expect(text).toContain('Miss it and the next one is 5:20am, 4h 10m later');
	});

	it('says nothing later arrives in time for a leg that has to make a check-in', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 40 as Duration, legs: [] });
		const transit: Transfer = {
			mode: 'transit',
			duration: 50 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T05:15:00'),
				arrival: localDateTime('2026-06-01T05:59:00'),
				following: [],
				earlier: [localDateTime('2026-06-01T04:45:00')],
				plannedFor: arriveByDeadline('2026-06-01T06:15:00')
			}
		};

		const text = normalizedText(mountPicker({ itinerary, alternatives: [transit] }));

		expect(text).toContain('The last one that gets you there by 6:15am');
		expect(text).toContain('Miss it and nothing later arrives in time');
		expect(text).toContain('Earlier and still in time: 4:45am');
		// Never the overnight-gap framing: an empty `following` here means the deadline was
		// respected, not that the timetable ran out.
		expect(text).not.toContain('Nothing runs after it');
	});

	it('shows which journey moment the schedule was planned for', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 40 as Duration, legs: [] });
		const transit: Transfer = {
			mode: 'transit',
			duration: 50 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T05:15:00'),
				following: [],
				plannedFor: arriveByDeadline('2026-06-01T06:15:00')
			}
		};

		const text = normalizedText(mountPicker({ itinerary, alternatives: [transit] }));

		expect(text).toContain('Planned for Mon, 1 Jun, arriving by 6:15am');
	});
});

describe('TransportPicker: telling "no service" from "nobody asked" (issue #135)', () => {
	const roadOnly: Transfer[] = [
		{ mode: 'walk', duration: 316 as Duration, legs: [] },
		{ mode: 'taxi', duration: 59 as Duration, legs: [] }
	];

	it('says the timetable was asked and had nothing, for a place with no coverage', () => {
		// Bucharest, verbatim from the issue: Transitous returned `itineraries: []` and the
		// picker offered Walk 5h 16m, Drive 59m, Taxi 59m with no hint either way.
		const itinerary = baseItinerary({ mode: 'walk', duration: 316 as Duration, legs: [] });

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: roadOnly,
				transitAnswer: { answer: 'nothing-found', plannedFor: departAfter('2026-06-01T01:00:00') }
			})
		);

		expect(text).toContain('No public transport data for this area');
		expect(text).toContain('had no service between these two points');
	});

	it('says nobody asked, and why, rather than implying there is no bus', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 316 as Duration, legs: [] });

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: roadOnly,
				transitAnswer: { answer: 'not-asked', reason: 'budget-spent' }
			})
		);

		expect(text).toContain('was not checked for this option');
		expect(text).not.toContain('No public transport data for this area');
	});

	it('says the timetable belongs to another bed, once the traveller swaps property (issue #267)', () => {
		// `routeToProperty` asks road modes only, so a swapped bed gets a real road journey
		// to the right address and no bus times at all. Left silent, "Taxi, 1h 27m" reads as
		// a claim that a taxi is how you get there.
		const itinerary = baseItinerary({ mode: 'taxi', duration: 87 as Duration, legs: [] });

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: roadOnly,
				transitAnswer: { answer: 'not-asked', reason: 'other-property' }
			})
		);

		expect(text).toContain('Road journey only');
		expect(text).toContain('not looked up for this property');
		// The budget wording would name a ration this swap never touched.
		expect(text).not.toContain('already used its timetable lookups');
		expect(text).not.toContain('No public transport data for this area');
	});

	it('says a route came back and was refused, with the numbers it was refused on (issue #220)', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 316 as Duration, legs: [] });

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: roadOnly,
				transitAnswer: {
					answer: 'answered',
					plannedFor: departAfter('2026-06-01T01:00:00'),
					// The owner's own Birmingham leg: 21h 27m to cover 9.7 km.
					withheld: { count: 2, quickest: 1287 as Duration, straightLineKm: 9.7 }
				}
			})
		);

		expect(text).toContain('The quickest of the 2 routes that came back took 21h 27m');
		expect(text).toContain('10 km in a straight line');
		// The lie this replaces. Transitous answered; this app is what refused it.
		expect(text).not.toContain('had no service between these two points');
	});

	it("quotes the provider's own failure, status code included", () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 316 as Duration, legs: [] });

		const text = normalizedText(
			mountPicker({
				itinerary,
				alternatives: roadOnly,
				transitAnswer: {
					answer: 'failed',
					error: { code: 'quota-exceeded', message: 'Transitous responded 429: slow down', status: 429 }
				}
			})
		);

		expect(text).toContain('429: Transitous responded 429: slow down');
	});

	it('offers the lookup and names what it costs before it is pressed (issue #267)', () => {
		const itinerary = baseItinerary({ mode: 'taxi', duration: 87 as Duration, legs: [] });
		let pressed = 0;

		const root = mountPicker({
			itinerary,
			alternatives: roadOnly,
			transitAnswer: { answer: 'not-asked', reason: 'other-property' },
			oncheckTransit: () => {
				pressed += 1;
			}
		});

		const text = normalizedText(root);
		// The count is on the row before the press, not reported afterwards. Transitous is
		// run by volunteers and the traveller is the one authorising the requests.
		expect(text).toContain('2 timetable lookups, of the 12 this search may spend');

		const button = [...root.querySelectorAll('button')].find((element) =>
			element.textContent?.includes('Check public transport')
		);
		expect(button).toBeDefined();
		button?.click();
		flushSync();
		expect(pressed).toBe(1);
	});

	it('offers no lookup when the caller has none to run', () => {
		// The notice stands alone, exactly as it did before the button existed: an
		// affordance that cannot do anything is worse than no affordance.
		const itinerary = baseItinerary({ mode: 'taxi', duration: 87 as Duration, legs: [] });

		const root = mountPicker({
			itinerary,
			alternatives: roadOnly,
			transitAnswer: { answer: 'not-asked', reason: 'other-property' }
		});

		expect(normalizedText(root)).toContain('Road journey only');
		expect(normalizedText(root)).not.toContain('Check public transport');
	});

	it('stays quiet when a transit option is actually on offer', () => {
		const itinerary = baseItinerary({ mode: 'walk', duration: 40 as Duration, legs: [] });
		const transit: Transfer = {
			mode: 'transit',
			duration: 25 as Duration,
			legs: [],
			transitSchedule: {
				intended: localDateTime('2026-06-01T01:10:00'),
				following: [],
				plannedFor: departAfter('2026-06-01T01:00:00')
			}
		};

		const root = mountPicker({
			itinerary,
			alternatives: [transit],
			transitAnswer: { answer: 'answered', plannedFor: departAfter('2026-06-01T01:00:00') }
		});

		expect(root.querySelector('[data-testid="transit-notice"]')).toBeNull();
	});
});
