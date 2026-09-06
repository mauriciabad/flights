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
	PropertyRating,
	Stay,
	Transfer
} from '../domain';
import { buildItineraries } from '../algorithm/build';
import { recomputeItinerarySelection } from '../algorithm/recompute-selection';
import ItineraryTimeline from './ItineraryTimeline.svelte';
import ItineraryTimelineSelectionHarness from './ItineraryTimelineSelectionHarness.svelte';

/**
 * Mounted with Svelte 5's own `mount`/`flushSync` rather than @testing-library/svelte,
 * which this project does not depend on (see package.json). These are the same primitives
 * the framework itself is built on, so no extra dependency is needed to prove the rendered
 * DOM, not just the underlying data, is correct.
 */

const country: Country = { isoCode: 'AT', name: 'Austria' };
const city: City = { name: 'Vienna', coordinates: { latitude: 48.2, longitude: 16.37 }, country };

function makeAirport(iataCode: string, name: string, sizeClass: Airport['sizeClass'] = 'medium'): Airport {
	return { iataCode, name, coordinates: { latitude: 0, longitude: 0 }, city, country, sizeClass };
}

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

function makeFlight(
	departureAirport: string,
	arrivalAirport: string,
	departure: LocalDateTime,
	arrival: LocalDateTime,
	duration: number,
	priceMinorUnits = 5000
): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Test Air' },
		flightNumber: 'FR123',
		departureAirport,
		arrivalAirport,
		departure,
		arrival,
		duration: duration as Duration,
		price: { minorUnits: priceMinorUnits, currency: 'EUR' },
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.test/offer'
	};
}

function makeStay(pricePerNightMinorUnits = 3000, rating?: PropertyRating): Stay {
	return {
		property: { name: 'Test Hostel', coordinates: { latitude: 0, longitude: 0 }, images: [], rating },
		roomKind: 'dorm',
		pricePerNight: { minorUnits: pricePerNightMinorUnits, currency: 'EUR' }
	};
}

function makeTransfer(duration: number): Transfer {
	return { mode: 'walk', duration: duration as Duration, legs: [] };
}

const origin = makeAirport('LGW', 'London Gatwick');
const connection = makeAirport('VIE', 'Vienna International');
const destination = makeAirport('IST', 'Istanbul Airport');

/** One itinerary built through the real algorithm (not hand-authored), so its freeTime,
 * nights and totals are exactly what the domain rules would produce, the same guarantee
 * build.test.ts relies on. */
function makeItinerary(
	overrides: {
		outboundArrival?: LocalDateTime;
		onwardDeparture?: LocalDateTime;
		stayRating?: PropertyRating;
	} = {}
): Itinerary {
	const outboundArrival = overrides.outboundArrival ?? localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120);
	const onwardDeparture = overrides.onwardDeparture ?? localDateTime('2026-06-03T14:00:00', 'Europe/Vienna', 120);

	const [itinerary] = buildItineraries({
		originAirport: origin,
		destinationAirport: destination,
		outboundOffers: [makeFlight('LGW', 'VIE', outboundArrival, outboundArrival, 150)],
		onwardOffers: [makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90)],
		connectionAirports: { VIE: connection },
		connectionResources: {
			VIE: {
				stay: makeStay(3000, overrides.stayRating),
				transferToHotel: makeTransfer(30),
				transferToConnectionAirport: makeTransfer(30)
			}
		},
		waitingTimeRules: [{ waitingTime: 120 as Duration }]
	});
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

function renderTimeline(itinerary: Itinerary) {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(ItineraryTimeline, { target, props: { itinerary } });
	flushSync();
	return target;
}

/** Exercises the `selectedSegmentId` binding (issue #73) through a real `bind:`, which a
 * `.ts` test file cannot write directly — Svelte's own testing docs call for a small
 * wrapper component for exactly this. `externalSelect` plays the part `ItineraryMap`
 * (issue #26) will play for real: writing to the shared bound variable from outside.
 * `withExpansion` makes the harness pass a probe `expansion` snippet and one option mark,
 * the other two things only a `.svelte` file can author. */
function renderSelectionHarness(itinerary: Itinerary, options: { withExpansion?: boolean } = {}) {
	target = document.createElement('div');
	document.body.appendChild(target);
	const harness = mount(ItineraryTimelineSelectionHarness, { target, props: { itinerary, ...options } });
	instance = harness;
	flushSync();
	return { root: target, harness };
}

describe('ItineraryTimeline, overnight local-time correctness', () => {
	it('renders the departure date and the next-calendar-day arrival date correctly at both ends', () => {
		// Departs late evening in Vienna, arrives after midnight local time in Istanbul: an
		// itinerary where naively formatting a UTC instant in the viewer's own timezone
		// would show the wrong date on one or both ends.
		const outboundDeparture = localDateTime('2026-09-04T23:10:00', 'Europe/Vienna', 120);
		const outboundArrival = localDateTime('2026-09-05T00:35:00', 'Europe/Istanbul', 180);

		// The onward flight departs several days after the overnight outbound arrival above,
		// so it clears the minimum-layover filter (an onward flight scheduled *before* the
		// outbound one lands would otherwise make buildItineraries drop the pair entirely).
		const onwardDeparture = localDateTime('2026-09-07T14:00:00', 'Europe/Vienna', 120);

		const [itinerary] = buildItineraries({
			originAirport: origin,
			destinationAirport: destination,
			outboundOffers: [makeFlight('LGW', 'VIE', outboundDeparture, outboundArrival, 85)],
			onwardOffers: [makeFlight('VIE', 'IST', onwardDeparture, onwardDeparture, 90)],
			connectionAirports: { VIE: connection },
			connectionResources: {
				VIE: {
					stay: makeStay(),
					transferToHotel: makeTransfer(30),
					transferToConnectionAirport: makeTransfer(30)
				}
			},
			waitingTimeRules: [{ waitingTime: 120 as Duration }]
		});
		expect(itinerary).toBeDefined();

		const root = renderTimeline(itinerary);
		const outboundRow = root.querySelector('[data-segment="outbound-flight"]');
		expect(outboundRow).not.toBeNull();

		const times = outboundRow!.querySelectorAll('.tl-time-clock');
		const dates = outboundRow!.querySelectorAll('.tl-time-date');
		expect(times[0].textContent).toBe('11:10pm');
		expect(times[1].textContent).toBe('12:35am');
		// The two ends land on different calendar dates, and each shows its own airport's
		// wall-clock date, not the same date twice or a date shifted by the machine's own
		// timezone (which, in CI, is neither Vienna's nor Istanbul's).
		expect(dates[0].textContent).toBe('Fri, 4 Sep');
		expect(dates[1].textContent).toBe('Sat, 5 Sep');

		// The "next day" flag is the redundant, at-a-glance confirmation of the same fact.
		expect(outboundRow!.querySelector('.tl-note-plusday')).not.toBeNull();
	});

	it('does not flag a same-day flight as landing the next day', () => {
		const itinerary = makeItinerary();
		const root = renderTimeline(itinerary);
		const outboundRow = root.querySelector('[data-segment="outbound-flight"]');
		expect(outboundRow!.querySelector('.tl-note-plusday')).toBeNull();
	});
});

describe('ItineraryTimeline, the stopover row and the missing bed (issue #185)', () => {
	/** The same itinerary the other tests use, minus the bed: the default state of a search
	 * where the stay provider found nothing or could not answer. */
	function makeBedlessItinerary(): Itinerary {
		const [itinerary] = buildItineraries({
			originAirport: origin,
			destinationAirport: destination,
			outboundOffers: [
				makeFlight(
					'LGW',
					'VIE',
					localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120),
					localDateTime('2026-06-01T10:00:00', 'Europe/Vienna', 120),
					150
				)
			],
			onwardOffers: [
				makeFlight(
					'VIE',
					'IST',
					localDateTime('2026-06-03T14:00:00', 'Europe/Vienna', 120),
					localDateTime('2026-06-03T14:00:00', 'Europe/Vienna', 120),
					90
				)
			],
			connectionAirports: { VIE: connection },
			connectionResources: { VIE: {} },
			waitingTimeRules: [{ waitingTime: 120 as Duration }]
		});
		return itinerary;
	}

	// Anchored on the fact rather than one sentence: a check that greps for "No bed priced
	// yet." passes vacuously the moment somebody rewords it, which has already happened once
	// in this repo. Whatever this row says, the bed must not be among it — the price line's
	// chip qualifies the number and the row's own fold carries the reason.
	it('says nothing about a bed when none was priced', () => {
		const itinerary = makeBedlessItinerary();
		expect(itinerary.stay).toBeUndefined();
		expect(itinerary.nightsInConnection).toBeGreaterThan(0);

		const root = renderTimeline(itinerary);
		const stopoverRow = root.querySelector('[data-segment="free-time"]');
		expect(stopoverRow).not.toBeNull();
		expect(stopoverRow!.textContent).not.toMatch(/bed/i);
		// The row still carries its own fact, which is the nights it covers.
		expect(stopoverRow!.textContent).toMatch(/night/i);
	});

	it('still names the property when a bed was priced, because that is this row\'s own fact', () => {
		const root = renderTimeline(makeItinerary());
		const stopoverRow = root.querySelector('[data-segment="free-time"]');
		expect(stopoverRow!.textContent).toContain('Test Hostel');
	});

	it('rates the bed on the scale its provider published, with a space before the separator', () => {
		// #245, verbatim off production on 2026-09-05: "London Backpackers · dorm· rated
		// 87/5". Hostelworld had said 87 out of 100 for that hostel (confirmed live the same
		// day), so both halves were wrong and the separator had lost its space.
		const root = renderTimeline(makeItinerary({ stayRating: { value: 87, outOf: 100 } }));
		const line = root.querySelector('.tl-stopover-stay');
		const text = line!.textContent!.replace(/\s+/g, ' ').trim();
		expect(text).toBe('Test Hostel · dorm · rated 8.7/10');
	});
});

describe('ItineraryTimeline, selection binding for the map (issue #73)', () => {
	it('clicking a row selects that segment and marks the row selected', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]');
		expect(row).not.toBeNull();
		// `aria-current` (not `aria-selected` — see the component's own comment on why
		// none of these rows carry an ARIA option/listbox role any more) is absent
		// entirely on an unselected row, not `'false'`.
		expect(row!.getAttribute('aria-current')).toBeNull();

		row!.click();
		flushSync();

		expect(harness.currentSelection()).toBe('outbound-flight');
		expect(row!.getAttribute('aria-current')).toBe('true');
		expect(row!.classList.contains('is-selected')).toBe(true);
	});

	it('selecting a different row moves the highlight, leaving only one row selected', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		root.querySelector<HTMLLIElement>('[data-segment="origin-waiting"]')!.click();
		flushSync();
		expect(harness.currentSelection()).toBe('origin-waiting');

		root.querySelector<HTMLLIElement>('[data-segment="onward-flight"]')!.click();
		flushSync();

		expect(harness.currentSelection()).toBe('onward-flight');
		expect(
			root.querySelector('[data-segment="origin-waiting"]')!.getAttribute('aria-current')
		).toBeNull();
		expect(root.querySelector('[data-segment="onward-flight"]')!.getAttribute('aria-current')).toBe(
			'true'
		);
	});

	it('a selection written from outside (as ItineraryMap does) highlights the matching row', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		harness.externalSelect('connection-waiting');
		flushSync();

		expect(
			root.querySelector('[data-segment="connection-waiting"]')!.getAttribute('aria-current')
		).toBe('true');
		expect(root.querySelector('[data-segment="outbound-flight"]')!.getAttribute('aria-current')).toBeNull();
	});

	it('Enter and Space activate a focused row the same way a click does', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="free-time"]')!;
		row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(harness.currentSelection()).toBe('free-time');

		const other = root.querySelector<HTMLLIElement>('[data-segment="onward-flight"]')!;
		other.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		flushSync();
		expect(harness.currentSelection()).toBe('onward-flight');
	});

	it('a Space press on a control inside a row does not hijack that control', () => {
		// Regression guard for the row's own onkeydown: without checking that the row itself
		// (not a descendant) is the event's target, this handler's preventDefault() on a
		// bubbled Space press would suppress the native button's own space-triggered click
		// before the browser gets to fire it.
		//
		// Driven through the `expansion` snippet's probe button since issue #313, which
		// removed the waiting-time stepper this used to press. That is now the only kind of
		// control a row can contain, so it is the only thing left for the guard to protect.
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary, { withExpansion: true });

		root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]')!.click();
		flushSync();
		const probe = root.querySelector<HTMLButtonElement>('[data-segment="outbound-flight"] .tl-expansion .probe')!;
		probe.focus();
		probe.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		flushSync();

		// The row's handler saw a bubbled event whose target was the button, not the row, so
		// it left the selection alone instead of toggling the row shut under the control the
		// reader was pressing.
		expect(harness.currentSelection()).toBe('outbound-flight');
	});

	it('clicking the selected row again clears the selection and drops aria-current', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]')!;
		row.click();
		flushSync();
		expect(harness.currentSelection()).toBe('outbound-flight');

		row.click();
		flushSync();

		// The map reads null as "show the whole route", and the row's expansion (below)
		// folds away with it, so a second activation clears rather than re-asserts.
		expect(harness.currentSelection()).toBeNull();
		expect(row.getAttribute('aria-current')).toBeNull();
		expect(row.classList.contains('is-selected')).toBe(false);
	});

	it('Enter on the selected row clears the selection the same way a second click does', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="free-time"]')!;
		row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(harness.currentSelection()).toBe('free-time');

		row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(harness.currentSelection()).toBeNull();
	});

	it('the expansion snippet renders inside the selected row only, as that row\'s .tl-expansion', () => {
		const itinerary = makeItinerary();
		const { root } = renderSelectionHarness(itinerary, { withExpansion: true });

		// Nothing is unfolded until a row is selected.
		expect(root.querySelectorAll('.tl-expansion').length).toBe(0);

		root.querySelector<HTMLLIElement>('[data-segment="onward-flight"]')!.click();
		flushSync();

		const expansions = root.querySelectorAll('.tl-expansion');
		expect(expansions.length).toBe(1);
		const expansion = expansions[0]!;
		// Inside the row's own <li>, a fifth child after the four grid cells, so the row
		// list stays flat and the four-column subgrid contract holds.
		expect(expansion.parentElement?.getAttribute('data-segment')).toBe('onward-flight');
		expect(expansion.parentElement?.children.length).toBe(5);
		expect(expansion.textContent).toContain('probe onward-flight');
		expect(root.querySelector('[data-segment="outbound-flight"] .tl-expansion')).toBeNull();
	});

	it('the expansion moves with the selection and folds away when it clears', () => {
		const itinerary = makeItinerary();
		const { root } = renderSelectionHarness(itinerary, { withExpansion: true });

		root.querySelector<HTMLLIElement>('[data-segment="onward-flight"]')!.click();
		flushSync();
		root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]')!.click();
		flushSync();

		expect(root.querySelector('[data-segment="onward-flight"] .tl-expansion')).toBeNull();
		expect(root.querySelector('[data-segment="outbound-flight"] .tl-expansion')?.textContent).toContain(
			'probe outbound-flight'
		);

		root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]')!.click();
		flushSync();
		expect(root.querySelectorAll('.tl-expansion').length).toBe(0);
	});

	it('a click inside the expansion leaves the selection alone', () => {
		// The expansion is where ResultDetail puts a picker, and a click on a picker's radio
		// bubbles up to the row's own onclick. Without the guard, picking an alternative
		// would also toggle the row and fold away the picker that offered it.
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary, { withExpansion: true });

		root.querySelector<HTMLLIElement>('[data-segment="outbound-flight"]')!.click();
		flushSync();
		root.querySelector<HTMLButtonElement>('[data-segment="outbound-flight"] .tl-expansion .probe')!.click();
		flushSync();

		expect(harness.currentSelection()).toBe('outbound-flight');
		expect(root.querySelector('[data-segment="outbound-flight"] .tl-expansion')).not.toBeNull();
	});

	it('an option mark prints on that row\'s content line and nowhere else', () => {
		const itinerary = makeItinerary();
		const { root } = renderSelectionHarness(itinerary, { withExpansion: true });

		// On the label's own line, not in the HOW MUCH column: there it cost every flight and
		// transfer row a third line.
		expect(root.querySelector('[data-segment="outbound-flight"] .tl-content')?.textContent).toContain('2 flights');
		expect(root.querySelector('[data-segment="outbound-flight"] .tl-meta')?.textContent).not.toContain('flights');
		expect(root.querySelector('[data-segment="onward-flight"] .tl-content')?.textContent).not.toContain('flights');
	});

	it('a wait row still selects from its own label, which is all a wait row does now', () => {
		// Issue #313 removed the stepper, so a wait row has nothing inside it to guard against
		// and nothing to do but select. What #141's guard used to protect here is covered
		// above, against the one kind of control a row can still contain.
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="origin-waiting"]')!;
		expect(row.querySelector('input'), 'the inline stepper is gone (issue #313)').toBeNull();

		row.querySelector<HTMLElement>('.tl-label')!.click();
		flushSync();
		expect(harness.currentSelection()).toBe('origin-waiting');
	});

	it('the ol root and flat li row structure are unchanged by the added interactivity', () => {
		// The mount target itself is a plain test-harness <div>, not part of the component;
		// its first child is this component's actual root, per the DOM contract issue #25
		// depends on (the <ol> itself, with no wrapper).
		const itinerary = makeItinerary();
		const root = renderTimeline(itinerary);

		const ol = root.firstElementChild;
		expect(ol?.tagName).toBe('OL');
		const rows = Array.from(ol!.querySelectorAll(':scope > li'));
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.classList.contains('tl-row')).toBe(true);
			expect(row.getAttribute('data-segment')).not.toBeNull();
			// No wrapper: every row is still exactly its own grid cells as direct children,
			// four of them since the timetable rewrite (when, rail, what, how much) and
			// the same four on every row, which is what lets each `<li>` subgrid the
			// list's columns without an intermediate element.
			expect(row.children.length).toBe(4);
		}
	});
});

describe('ItineraryTimeline, the transfer row reads as one line (issue #220)', () => {
	/** The shape the owner was shown, minus the flights: a transit transfer whose legs the
	 * row used to print in full, joined by commas. */
	function transitTransfer(): Transfer {
		return {
			mode: 'transit',
			duration: 52 as Duration,
			legs: [
				{ mode: 'walk', description: 'Walk (38 m)', duration: 1 as Duration },
				{
					mode: 'transit',
					description: 'Metro L1 to Hospital de Bellvitge (TMB)',
					vehicle: 'Metro',
					duration: 22 as Duration
				},
				{ mode: 'walk', description: 'Walk (341 m)', duration: 3 as Duration },
				{ mode: 'transit', description: 'Bus 46 to Aeroport BCN (TMB)', vehicle: 'Bus', duration: 9 as Duration },
				{ mode: 'walk', description: 'Walk (120 m)', duration: 2 as Duration }
			]
		};
	}

	function hotelRowText(transfer: Transfer): string {
		const itinerary = { ...makeItinerary(), transferToHotel: transfer };
		const root = renderTimeline(itinerary);
		const row = root.querySelector('[data-segment="transfer-to-hotel"]');
		if (!row) throw new Error('no transfer-to-hotel row');
		return row.querySelector('.tl-label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
	}

	it('summarises the journey instead of printing every leg', () => {
		const text = hotelRowText(transitTransfer());

		expect(text).toContain('Metro, then bus (1 change)');
		// The brick, gone: no line numbers, no operators, no walk distances on this row.
		expect(text).not.toContain('Walk (38 m)');
		expect(text).not.toContain('(TMB)');
	});

	it('separates the label from the detail with a character, not only with a margin', () => {
		// The owner's report of this row began "To Birmingham Central BackpackersPublic
		// transport". A CSS margin is invisible to anything that reads the page as text, so
		// the separator has to survive `textContent`, spaces and all.
		const text = hotelRowText(transitTransfer());
		expect(text).toContain('To Test Hostel · Metro, then bus (1 change)');
	});

	it('still names the mode when no provider named a vehicle', () => {
		expect(hotelRowText({ mode: 'walk', duration: 30 as Duration, legs: [] })).toContain('· Walk');
		// A taxi's single leg is not a "ride" worth counting: the mode is the better word.
		expect(
			hotelRowText({ mode: 'taxi', duration: 54 as Duration, legs: [{ mode: 'taxi', duration: 54 as Duration }] })
		).toContain('· Taxi');
	});
});

describe('ItineraryTimeline, the row into town says what the ride costs (issue #290)', () => {
	/** The fixture routes a 30-minute leg into the city. Add the traveller's own 15-minute
	 * walk-out and the stored duration becomes 45, of which only 30 is the journey. */
	function buffered(): Itinerary {
		const base = makeItinerary();
		return {
			...base,
			transferToHotel: { ...base.transferToHotel!, duration: 45 as Duration, landingBuffer: 15 as Duration }
		};
	}

	function rowText(root: HTMLElement, segment: string): string {
		return (root.querySelector(`[data-segment="${segment}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
	}

	function durationCell(root: HTMLElement, segment: string): string {
		return root.querySelector(`[data-segment="${segment}"] .tl-duration`)?.textContent?.trim() ?? '';
	}

	it('puts the ride in the duration column', () => {
		expect(durationCell(renderTimeline(buffered()), 'transfer-to-hotel')).toBe('30m');
	});

	it('keeps the 45 minutes on the row, named as the buffer plus the ride', () => {
		expect(rowText(renderTimeline(buffered()), 'transfer-to-hotel')).toContain(
			'Plus your own 15m to get out of the airport, so you arrive 45m after landing.'
		);
	});

	it('leaves the leg back to the airport alone: nothing pads a leg that ends at a gate', () => {
		const root = renderTimeline(buffered());
		expect(durationCell(root, 'transfer-to-connection-airport')).toBe('30m');
		expect(rowText(root, 'transfer-to-connection-airport')).not.toContain('to get out of the airport');
	});
});

describe('ItineraryTimeline, the hour the bus actually leaves (issue #344)', () => {
	/** The fixture lands at 10:00 in Vienna. Give its ride into town a timetable whose first
	 * departure is `intended`, and the row has a real wait to describe. */
	function withDeparture(intended: string): Itinerary {
		const base = makeItinerary();
		return {
			...base,
			transferToHotel: {
				...base.transferToHotel!,
				mode: 'transit',
				landingBuffer: 15 as Duration,
				transitSchedule: {
					intended: localDateTime(intended, 'Europe/Vienna', 120),
					following: [],
					plannedFor: {
						time: localDateTime('2026-06-01T10:15:00', 'Europe/Vienna', 120),
						arriveBy: false
					}
				}
			}
		};
	}

	function rowText(itinerary: Itinerary): string {
		const root = renderTimeline(itinerary);
		return (root.querySelector('[data-segment="transfer-to-hotel"]')?.textContent ?? '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	it('names the wait, not just the clock, when the timetable has stopped', () => {
		// #282's own example in the fixture's shape: the row's clock says the departure and
		// nothing said how far away it is. Land at 10:00, first bus at 19:00.
		expect(rowText(withDeparture('2026-06-01T19:00:00'))).toContain(
			'First departure 7pm, 9h after you land.'
		);
	});

	it('stays quiet about a wait the traveller would have had anyway', () => {
		expect(rowText(withDeparture('2026-06-01T10:12:00'))).not.toContain('First departure');
	});

	it('says nothing on a road leg, which has no timetable to wait for', () => {
		expect(rowText(makeItinerary())).not.toContain('First departure');
	});
});

/**
 * Issue #368. The rows between the two flights are a schedule the reader adds up, so the
 * wait row has to say what the layover leaves rather than what the traveller's buffer rule
 * asked for. With a real timetable on the ride back those are two different numbers, and the
 * rows stopped reaching the flight below them.
 */
describe('ItineraryTimeline, the wait after a ride that leaves when the metro does', () => {
	function portoTimeline() {
		const opo = (local: string) => localDateTime(local, 'Europe/Lisbon', 60);
		const [built] = buildItineraries({
			originAirport: origin,
			destinationAirport: destination,
			outboundOffers: [makeFlight('LGW', 'VIE', opo('2026-09-16T06:50:00'), opo('2026-09-16T06:50:00'), 120)],
			onwardOffers: [makeFlight('VIE', 'IST', opo('2026-09-17T06:10:00'), opo('2026-09-17T06:10:00'), 270)],
			connectionAirports: { VIE: connection },
			connectionResources: {
				VIE: {
					stay: makeStay(1240),
					transferAnchor: 'stay',
					transferToHotel: makeTransfer(69),
					transferToConnectionAirport: makeTransfer(67)
				}
			},
			waitingTimeRules: [{ waitingTime: 120 as Duration }]
		});
		const timetabled = recomputeItinerarySelection(built!, {
			transferToConnectionAirport: {
				mode: 'transit',
				duration: 67 as Duration,
				legs: [],
				transitSchedule: {
					intended: opo('2026-09-17T01:35:00'),
					arrival: opo('2026-09-17T02:38:00'),
					following: [],
					plannedFor: { time: opo('2026-09-17T04:10:00'), arriveBy: true }
				}
			}
		}).itinerary;
		return renderTimeline(timetabled);
	}

	it('prints the wait the timetable leaves, not the two-hour rule', () => {
		const row = portoTimeline().querySelector('[data-segment="connection-waiting"]');
		expect(row?.querySelector('.tl-duration')?.textContent).toBe('3h 32m');
	});
});

/**
 * Issue #399, the same reading at the origin end. Nothing here contradicts anything on
 * screen, which is what makes it worse: the row simply prints the traveller's own rule
 * back at them, and the three rows above the outbound flight do not reach it.
 */
describe('ItineraryTimeline, the wait before a flight the coach beats by hours', () => {
	function begurTimeline() {
		const bcn = (local: string) => localDateTime(local, 'Europe/Madrid', 120);
		const [built] = buildItineraries({
			originAirport: origin,
			destinationAirport: destination,
			outboundOffers: [makeFlight('LGW', 'VIE', bcn('2026-09-16T05:50:00'), bcn('2026-09-16T06:50:00'), 120)],
			onwardOffers: [makeFlight('VIE', 'IST', bcn('2026-09-17T06:10:00'), bcn('2026-09-17T08:40:00'), 270)],
			connectionAirports: { VIE: connection },
			connectionResources: { VIE: { stay: makeStay(1240), transferAnchor: 'stay' } },
			originLocation: { label: 'Begur', coordinates: { latitude: 41.9546686, longitude: 3.2067269 } },
			transferToOriginAirport: makeTransfer(223),
			waitingTimeRules: [{ waitingTime: 120 as Duration }]
		});
		const timetabled = recomputeItinerarySelection(built!, {
			transferToOriginAirport: {
				mode: 'transit',
				duration: 223 as Duration,
				legs: [],
				transitSchedule: {
					intended: bcn('2026-09-15T20:00:00'),
					arrival: bcn('2026-09-15T23:36:00'),
					following: [],
					plannedFor: { time: bcn('2026-09-16T03:50:00'), arriveBy: true }
				}
			}
		}).itinerary;
		return renderTimeline(timetabled);
	}

	it('prints the wait the coach leaves, not the two-hour rule', () => {
		const row = begurTimeline().querySelector('[data-segment="origin-waiting"]');
		expect(row?.querySelector('.tl-duration')?.textContent).toBe('6h 14m');
	});

	it('puts the ride on the same clock the wait starts from', () => {
		// 8pm boarding on the row above, then 6h 14m, then a 5:50am flight. The three rows
		// reach each other, which is the whole of this issue.
		const timeline = begurTimeline();
		const ride = timeline.querySelector('[data-segment="transfer-to-origin-airport"]');
		expect(ride?.querySelector('.tl-when')?.textContent?.trim()).toBe('8pm');
	});
});
