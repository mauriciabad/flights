import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Coordinates, Itinerary } from '../domain';
import { makeItinerary } from '../results/test-support';
import { timeFormat } from '../settings/time-format.svelte';
import StopoverBlock from './StopoverBlock.svelte';

/**
 * Issue #228. The owner settled a block of seven lines: three time lines in trip order,
 * then the stay, "always in that order and always present". These mount it and read the
 * lines back off the DOM, because the point of the issue is what a person sees, and the
 * pure half is already pinned in `free-time-days.test.ts`.
 *
 * Mounted with Svelte 5's own `mount`/`flushSync` rather than @testing-library/svelte,
 * which this project does not depend on. Same primitives the framework is built on.
 */

let target: HTMLElement | undefined;
let component: Record<string, unknown> | undefined;

/**
 * Everything the block says, as one whitespace-normalised string.
 *
 * It used to be an array of `<p>` texts, which stopped describing the block when issue
 * #279 gave the stay half a shape: the rate and the distance are a caption over a figure
 * now, not a sentence. Normalising the whole thing keeps every assertion below readable
 * and makes them stronger, because "Per night €20.00" only appears in this string when the
 * caption and the figure are actually next to each other. A rail that pairs the right
 * label with the wrong number is the mistake worth catching here.
 */
function render(itinerary: Itinerary, connectionLabel = 'London'): string {
	mountBlock(itinerary, connectionLabel);
	return text();
}

function mountBlock(
	itinerary: Itinerary,
	connectionLabel = 'London',
	connectionCoordinates?: Coordinates
) {
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(StopoverBlock, {
		target,
		props: { itinerary, connectionLabel, connectionCoordinates }
	});
	flushSync();
}

const text = () => target!.textContent!.replace(/\s+/g, ' ').trim();

/** The three lines issue #228 settled, still their own elements and still in trip order.
 * The city name above them is a field label rather than one of the lines, so it is out. */
const timeLines = () =>
	[...target!.querySelectorAll('.stopover > p:not(.stopover-label)')].map((p) =>
		p.textContent!.trim()
	);

beforeEach(() => {
	timeFormat.reset();
});

afterEach(() => {
	if (component) unmount(component);
	target?.remove();
	component = undefined;
	target = undefined;
});

/** The London stopover from the owner's own comment: in Friday evening, out Monday
 * morning, two whole days in between, a bed for two nights and a ride to reach it. */
function londonStopover(overrides: Parameters<typeof makeItinerary>[0] = {}): Itinerary {
	return makeItinerary({
		freeTimeStart: '2026-10-09T21:10:00',
		freeTimeEnd: '2026-10-12T09:05:00',
		nightsInConnection: 2,
		...overrides
	});
}

describe('the block the owner settled on', () => {
	it('prints the three time lines in trip order, then the stay', () => {
		render(londonStopover());
		expect(timeLines()).toEqual([
			'Fri 9 from 9:10pm',
			'2 full days: Sat, Sun',
			'Mon 12 until 9:05am'
		]);
	});

	it('names the property, the room and the nights with their rate', () => {
		const block = render(londonStopover());
		expect(block).toContain('Test stay');
		expect(block).toContain('Private room');
		// Issue #279 split the one sentence into two labelled figures. Same two numbers,
		// each paired with the caption that says what it is.
		expect(block).toContain('Per night €20.00');
		expect(block).toContain('Nights 2');
	});

	// Issue #206. Both surfaces that print this rate go through `bedNightlyRate`, so a card
	// reading "Bed, 2 nights × €13.00 each" and a panel reading €39.00 for the same bed is
	// not a state this app can reach.
	it('says who a room rate covers rather than splitting it between them', () => {
		// A private room is one unit of inventory whatever the party size, measured, not
		// assumed: Hostelworld says in its own words that three people booking a four-bed
		// private pay for four.
		expect(render(londonStopover({ travellers: 3 }))).toContain('Per night €20.00 for 3');
	});

	it('prints the per-person rate a provider quoted, marked as each', () => {
		const base = londonStopover({ travellers: 3 });
		const inADorm: Itinerary = {
			...base,
			stay: {
				...base.stay!,
				roomKind: 'dorm',
				pricePerNight: { minorUnits: 3900, currency: 'EUR' },
				pricePerPersonPerNight: { minorUnits: 1300, currency: 'EUR' }
			}
		};

		expect(render(inADorm)).toContain('Per night €13.00 each');
	});

	// AGENTS.md: currency symbol first, English convention, and "each way" rather than
	// "/way" for a fare paid in both directions. That ruling (commit 0199dee) is later than
	// the "10 EUR/way" in his #228 comment, and he flagged the symbol side there himself as
	// a repo-wide change to confirm before touching.
	it('writes the ride to the bed with the symbol first and "each way"', () => {
		const withFare: Itinerary = {
			...londonStopover(),
			transferToHotel: {
				mode: 'taxi',
				duration: 30 as Itinerary['times']['free'],
				price: { minorUnits: 1000, currency: 'EUR' },
				legs: []
			}
		};
		expect(render(withFare)).toContain('Taxi, 30m from the airport, €10.00 each way');
	});

	// Issue #212: a walk with no fare and a ride nobody quoted mean opposite things, and
	// `unpricedTransferNote` is the one place that says which.
	it('separates a walk that is free from a ride nobody priced', () => {
		expect(render(londonStopover())).toContain('Walk, 15m from the airport, no fare');

		const unquoted: Itinerary = {
			...londonStopover(),
			transferToHotel: { mode: 'transit', duration: 25 as Itinerary['times']['free'], legs: [] }
		};
		expect(render(unquoted)).toContain('Public transport, 25m from the airport, price not available');
	});
});

describe('what it says when a fact is missing', () => {
	it('calls an unpriced bed a floor rather than a pending purchase', () => {
		// Issue #140 ruled out "yet" for a state nothing is about to change.
		const noBed = londonStopover();
		const { stay: _stay, ...withoutStay } = noBed;
		const block = render(withoutStay as Itinerary);
		expect(block).toContain('No bed priced, so the total is a floor');
		expect(block).not.toContain('yet');
	});

	it('says a same-day connection has no bed to price, rather than a missing one', () => {
		const sameDay = makeItinerary({
			freeTimeStart: '2026-10-10T02:00:00',
			freeTimeEnd: '2026-10-10T09:00:00',
			nightsInConnection: 0
		});
		const { stay: _stay, ...withoutStay } = sameDay;
		expect(render(withoutStay as Itinerary)).toContain('No night spent here, so there is no bed to price');
	});

	// "The stay block is always present in the same format." A line that disappeared when
	// nobody could route to the bed would let the block change shape at the moment it has
	// something to say. #211's sentence, the same one the timeline's transfer row prints.
	it('keeps the transport line when nothing routed to the bed', () => {
		const unrouted: Itinerary = { ...londonStopover(), transferToHotel: undefined };
		expect(render(unrouted)).toContain('The bed is priced, but no transport provider could route to it.');
	});

	// Issue #243: the traveller picked a property off the stay list, and the search routes
	// to the one property it picks itself. Nothing was asked about this address, so the
	// line above it would name a provider that never got the question.
	it('says nobody routed to a property the traveller picked, rather than blaming a provider', () => {
		const picked: Itinerary = {
			...londonStopover(),
			transferToHotel: undefined,
			transferAnchor: 'unrouted-stay'
		};
		const block = render(picked);
		expect(block).toContain('Nothing routed to this property, so the journey to it is unknown.');
		expect(block).not.toMatch(/no transport provider could route/);
		// The bed itself is still real and still priced; only its journey is unknown.
		expect(block).toContain('Test stay');
	});

	it('still prints a count when the window has no length at all', () => {
		// `makeItinerary`'s default free-time window opens and closes on the same instant.
		expect(render(makeItinerary({}))).toContain('No full days');
	});
});

describe('the 24-hour setting', () => {
	it('reaches these edge lines like every other clock in the app', () => {
		timeFormat.set('24h');
		render(londonStopover());
		expect(timeLines()).toEqual(['Fri 9 from 21:10', '2 full days: Sat, Sun', 'Mon 12 until 09:05']);
	});
});

describe('a short overnight wait (issue #231)', () => {
	/** In at 11:30pm, out at 2:30am. The clock crosses a date and the traveller sleeps
	 * nowhere, which is exactly the card the owner was looking at. */
	function overnightWait(overrides: Parameters<typeof makeItinerary>[0] = {}): Itinerary {
		return makeItinerary({
			freeTimeStart: '2026-10-06T23:30:00',
			freeTimeEnd: '2026-10-07T02:30:00',
			freeTimeMinutes: 180,
			nightsInConnection: 0,
			...overrides
		});
	}

	it('names the wait and its length instead of a property nobody is checking into', () => {
		const block = render(overnightWait());
		expect(block).toContain('Overnight wait, 3h, too short to be worth a bed');
		expect(block).not.toContain('Test stay');
		expect(block).not.toContain('Per night');
	});

	it('still shows both edges of the window, so the date change is not hidden', () => {
		render(overnightWait());
		expect(timeLines()).toEqual([
			'Tue 6 from 11:30pm',
			'No full days',
			'Wed 7 until 2:30am'
		]);
	});

	it('does not tell a traveller awake at 3am that their connection is same-day', () => {
		const unrouted = overnightWait();
		const { stay: _stay, ...withoutStay } = unrouted;
		const block = render({ ...withoutStay, transferToHotel: undefined } as Itinerary);
		expect(block).toContain('Overnight wait, so there is no hotel leg here.');
	});
});

describe('how far out the bed is (issue #219)', () => {
	/** Gatwick, and a bed 2.8 km from it in Horley - the pair the issue measured. */
	const GATWICK = { latitude: 51.1537, longitude: -0.1821 };

	function withBedAt(latitude: number, longitude: number): Itinerary {
		const base = londonStopover();
		return {
			...base,
			stay: { ...base.stay!, property: { ...base.stay!.property, coordinates: { latitude, longitude } } }
		};
	}

	function renderWithAirport(itinerary: Itinerary): string {
		mountBlock(itinerary, 'London', GATWICK);
		return text();
	}

	it('prints the distance as a figure of its own, under the label that names it', () => {
		// 0.0252 degrees of latitude north of Gatwick is 2.8 km.
		const block = renderWithAirport(withBedAt(GATWICK.latitude + 0.0252, GATWICK.longitude));
		expect(block).toContain('From airport 2.8 km');
		expect(block).toContain('Private room');
	});

	it('drops the figure entirely when no airport position was resolved', () => {
		// Not a dash and not a zero. The itinerary carries only an IATA code, so there is no
		// point to measure from and no number to print.
		const block = render(londonStopover());
		expect(block).toContain('Private room');
		expect(block).not.toContain('From airport');
	});
});

describe('StopoverBlock, the ride and the walk-out are two numbers (issue #290)', () => {
	/** The issue's own reading: OSRM measures the taxi at 38 minutes, the traveller's rule
	 * adds 30 for getting out of Fiumicino, and the block called the sum a taxi. */
	const taxiFromTheRunway: Itinerary = {
		...londonStopover(),
		transferToHotel: {
			mode: 'taxi',
			duration: 68 as Itinerary['times']['free'],
			landingBuffer: 30 as Itinerary['times']['free'],
			legs: []
		}
	};

	it('quotes the ride beside the word Taxi', () => {
		const block = render(taxiFromTheRunway);
		expect(block).toContain('Taxi, 38m from the airport, price not available');
		expect(block).not.toContain('Taxi, 1h 8m');
	});

	it('keeps the hour and eight minutes, as the thing it actually is', () => {
		expect(render(taxiFromTheRunway)).toContain(
			'Plus your own 30m to get out of the airport, so you arrive 1h 8m after landing.'
		);
	});

	it('adds no second line to a leg nothing padded', () => {
		expect(render(londonStopover())).toContain('Walk, 15m from the airport, no fare');
		expect(render(londonStopover())).not.toContain('to get out of the airport');
	});
});
