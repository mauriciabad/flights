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
	Stay,
	Transfer
} from '../domain';
import { buildItineraries } from '../algorithm/build';
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

function makeStay(pricePerNightMinorUnits = 3000): Stay {
	return {
		property: { name: 'Test Hostel', coordinates: { latitude: 0, longitude: 0 }, images: [] },
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
function makeItinerary(overrides: { outboundArrival?: LocalDateTime; onwardDeparture?: LocalDateTime } = {}): Itinerary {
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
				stay: makeStay(),
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

/** Reads one figure from the totals rail by its label, rather than searching the whole
 * section's text: `formatDuration` can render the same string (e.g. "4h") for two
 * different totals that happen to share a value, so matching by the `<dt>` is the only way
 * to be sure which total actually moved.
 *
 * The rail is `MetricRail` now, shared with the results card, so the labels are that
 * component's (`itinerary-metrics.ts`) and its `<dd>` can carry a caveat span alongside
 * the figure; hence the trim. */
function getTotal(root: HTMLElement, label: string): string {
	const dt = Array.from(root.querySelectorAll('.itinerary-timeline-totals dt')).find(
		(el) => el.textContent === label
	);
	const dd = dt?.nextElementSibling;
	if (!dd) throw new Error(`No total found for label "${label}"`);
	return dd.textContent?.trim() ?? '';
}

describe('ItineraryTimeline, editable waiting time recomputes totals', () => {
	it('raising the origin waiting-time input grows the airport-waiting and total-time totals shown on the page', () => {
		const itinerary = makeItinerary();
		const root = renderTimeline(itinerary);

		const originInput = root.querySelector<HTMLInputElement>('[data-segment="origin-waiting"] input');
		expect(originInput).not.toBeNull();
		expect(originInput?.value).toBe('120');

		expect(getTotal(root, 'Airport wait')).toBe('4h'); // 2h origin + 2h connection
		const totalTimeBefore = getTotal(root, 'Door to door');
		const freeTotalBefore = getTotal(root, 'Free time');

		originInput!.value = '180';
		originInput!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		// The input itself now reads back the edited value...
		expect(originInput?.value).toBe('180');
		// ...and the totals section, a separate part of the page, picked up the same change:
		// airport waiting grows by the same 60 minutes the origin buffer grew by, and total
		// time grows by the same 60 minutes since the origin buffer isn't borrowed from
		// anywhere else on the itinerary.
		expect(getTotal(root, 'Airport wait')).toBe('5h');
		expect(getTotal(root, 'Door to door')).not.toBe(totalTimeBefore);
		// Free time is untouched: only the connection buffer borrows from it.
		expect(getTotal(root, 'Free time')).toBe(freeTotalBefore);
	});

	it('raising the connection waiting-time input shrinks free time and can add a night, without moving total time', () => {
		// A departure just after midnight so trimming or growing the connection buffer can
		// cross a calendar date and change nightsInConnection, not only the duration.
		const itinerary = makeItinerary({
			onwardDeparture: localDateTime('2026-06-03T00:45:00', 'Europe/Vienna', 120)
		});
		const root = renderTimeline(itinerary);

		const nightsBefore = getTotal(root, 'Nights');
		const freeTotalBefore = getTotal(root, 'Free time');
		const totalTimeBefore = getTotal(root, 'Door to door');
		const totalPriceBefore = getTotal(root, 'Total price');

		const connectionInput = root.querySelector<HTMLInputElement>('[data-segment="connection-waiting"] input');
		expect(connectionInput).not.toBeNull();

		// Shrink the connection buffer to nothing: free time's end moves later, and on this
		// fixture that crosses into the next calendar day, adding a night.
		connectionInput!.value = '0';
		connectionInput!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		expect(getTotal(root, 'Nights')).not.toBe(nightsBefore);
		expect(Number(getTotal(root, 'Nights'))).toBeGreaterThan(Number(nightsBefore));
		expect(getTotal(root, 'Free time')).not.toBe(freeTotalBefore);
		// Door-to-door time does not move: the connection buffer only trades against free
		// time, it never changes the total journey length.
		expect(getTotal(root, 'Door to door')).toBe(totalTimeBefore);
		// The total price grew, since an extra night was added to the stay.
		expect(getTotal(root, 'Total price')).not.toBe(totalPriceBefore);
	});

	it('the stepper buttons move the value by 15 minutes and stay in sync with the number input', () => {
		const itinerary = makeItinerary();
		const root = renderTimeline(itinerary);

		const row = root.querySelector('[data-segment="origin-waiting"]');
		const input = row?.querySelector<HTMLInputElement>('input');
		const [decrementBtn, incrementBtn] = Array.from(row?.querySelectorAll('button') ?? []);

		expect(input?.value).toBe('120');
		incrementBtn.click();
		flushSync();
		expect(input?.value).toBe('135');

		decrementBtn.click();
		decrementBtn.click();
		flushSync();
		expect(input?.value).toBe('105');
	});
});

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

	it('a Space press on the nested waiting-time stepper button does not hijack that button', () => {
		// Regression guard for the row's own onkeydown: without checking that the row itself
		// (not a descendant) is the event's target, this handler's preventDefault() on a
		// bubbled Space press would suppress the native button's own space-triggered click
		// before the browser gets to fire it.
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="origin-waiting"]')!;
		const stepperButton = row.querySelector('button')!;
		stepperButton.focus();
		stepperButton.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		flushSync();

		// The row's handler saw a bubbled event whose target was the button, not the row, so
		// it left selection untouched instead of claiming the segment on the button's behalf.
		expect(harness.currentSelection()).toBeNull();
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

	it('a click on the nested waiting-time stepper neither selects nor toggles the row', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="origin-waiting"]')!;
		row.querySelector('button')!.click();
		flushSync();

		expect(harness.currentSelection()).toBeNull();
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

	it('adjusting a waiting time never selects the row, so the map keeps the view the traveller set', () => {
		// Issue #141's third defect. Pressing minus or plus bubbled to the row, selected the
		// segment, and flew the map to that airport; four nudges of a buffer meant four
		// flights of the map. The number itself still changes, which is the whole point of
		// the control, so both halves are asserted here.
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		const row = root.querySelector<HTMLLIElement>('[data-segment="origin-waiting"]')!;
		const input = row.querySelector<HTMLInputElement>('.tl-stepper-input')!;
		const [decrease, increase] = Array.from(row.querySelectorAll<HTMLButtonElement>('.tl-stepper-btn'));
		const before = Number(input.value);

		increase.click();
		flushSync();
		expect(Number(input.value)).toBe(before + 15);
		expect(harness.currentSelection()).toBeNull();

		decrease.click();
		flushSync();
		expect(Number(input.value)).toBe(before);
		expect(harness.currentSelection()).toBeNull();

		// Clicking into the field to type a number is the same intent as pressing a stepper.
		input.click();
		flushSync();
		expect(harness.currentSelection()).toBeNull();

		// The rest of the row still selects: the guard is scoped to the editor, not the row.
		row.querySelector<HTMLElement>('.tl-label')!.click();
		flushSync();
		expect(harness.currentSelection()).toBe('origin-waiting');
	});

	it('keeps a selection that was already on the row while its waiting time is adjusted', () => {
		const itinerary = makeItinerary();
		const { root, harness } = renderSelectionHarness(itinerary);

		harness.externalSelect('connection-waiting');
		flushSync();

		const row = root.querySelector<HTMLLIElement>('[data-segment="connection-waiting"]')!;
		row.querySelectorAll<HTMLButtonElement>('.tl-stepper-btn')[1].click();
		flushSync();

		expect(harness.currentSelection()).toBe('connection-waiting');
		expect(row.getAttribute('aria-current')).toBe('true');
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
