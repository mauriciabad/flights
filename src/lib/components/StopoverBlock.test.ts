import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Itinerary } from '../domain';
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

function render(itinerary: Itinerary, connectionLabel = 'London'): string[] {
	target = document.createElement('div');
	document.body.appendChild(target);
	component = mount(StopoverBlock, { target, props: { itinerary, connectionLabel } });
	flushSync();
	// The city name is a field label rather than one of the block's lines, so it is not
	// part of what the owner specified and does not belong in these assertions.
	return [...target.querySelectorAll('p:not(.stopover-label)')].map((p) => p.textContent!.trim());
}

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
		const lines = render(londonStopover());
		expect(lines.slice(0, 3)).toEqual([
			'Fri 9 from 9:10pm',
			'2 full days: Sat, Sun',
			'Mon 12 until 9:05am'
		]);
	});

	it('names the property, the room and the nights with their rate', () => {
		const lines = render(londonStopover());
		expect(lines).toContain('Test stay');
		expect(lines).toContain('Private room');
		expect(lines).toContain('2 nights, €20.00/night');
	});

	// Issue #206. Both surfaces that print this rate go through `bedNightlyRate`, so a card
	// reading "Bed, 2 nights × €13.00 each" and a panel reading €39.00 for the same bed is
	// not a state this app can reach.
	it('says who a room rate covers rather than splitting it between them', () => {
		// A private room is one unit of inventory whatever the party size, measured, not
		// assumed: Hostelworld says in its own words that three people booking a four-bed
		// private pay for four.
		const lines = render(londonStopover({ travellers: 3 }));
		expect(lines).toContain('2 nights, €20.00/night for 3');
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

		expect(render(inADorm)).toContain('2 nights, €13.00/night each');
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
		const lines = render(withoutStay as Itinerary);
		expect(lines).toContain('No bed priced, so the total is a floor');
		expect(lines.join(' ')).not.toContain('yet');
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

	it('still prints a count when the window has no length at all', () => {
		// `makeItinerary`'s default free-time window opens and closes on the same instant.
		expect(render(makeItinerary({}))).toContain('No full days');
	});
});

describe('the 24-hour setting', () => {
	it('reaches these edge lines like every other clock in the app', () => {
		timeFormat.set('24h');
		const lines = render(londonStopover());
		expect(lines.slice(0, 3)).toEqual(['Fri 9 from 21:10', '2 full days: Sat, Sun', 'Mon 12 until 09:05']);
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
		const lines = render(overnightWait());
		expect(lines).toContain('Overnight wait, 3h, too short to be worth a bed');
		expect(lines).not.toContain('Test stay');
		expect(lines.join(' ')).not.toContain('/night');
	});

	it('still shows both edges of the window, so the date change is not hidden', () => {
		expect(render(overnightWait()).slice(0, 3)).toEqual([
			'Tue 6 from 11:30pm',
			'No full days',
			'Wed 7 until 2:30am'
		]);
	});

	it('does not tell a traveller awake at 3am that their connection is same-day', () => {
		const unrouted = overnightWait();
		const { stay: _stay, ...withoutStay } = unrouted;
		const lines = render({ ...withoutStay, transferToHotel: undefined } as Itinerary);
		expect(lines).toContain('Overnight wait, so there is no hotel leg here.');
	});
});
