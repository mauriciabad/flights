import { describe, expect, it } from 'vitest';
import type { FlightOffer, Itinerary } from '$lib/domain';
import {
	describeLadderFlights,
	overnightWaitNote,
	stopoverLadder,
	stopoverLengthLabel,
	stopoverLengthLabelFor
} from './stopover-nights';
import { makeItinerary, makeScoredResult } from './test-support';

/** `makeScoredResult` already assembles a whole itinerary from the fields these functions
 * read; this only names the two knobs that matter here. */
function itineraryWith(options: {
	nights: number;
	priceMinorUnits: number;
	outbound?: FlightOffer;
	onward?: FlightOffer;
}): Itinerary {
	const base = makeScoredResult({
		nightsInConnection: options.nights,
		priceMinorUnits: options.priceMinorUnits
	}).itinerary;
	return {
		...base,
		outboundFlight: options.outbound ?? base.outboundFlight,
		onwardFlight: options.onward ?? base.onwardFlight
	};
}

function option(itinerary: Itinerary) {
	return { nights: itinerary.nightsInConnection, itinerary };
}

describe('stopoverLengthLabel', () => {
	it('calls zero nights a flight change, never "0 nights"', () => {
		// Issue #225: a trip with no night in it is not a stopover of no nights, and the
		// owner's own word for it is a flight change.
		expect(stopoverLengthLabel(0)).toBe('Flight change');
	});

	it('is singular for one night', () => {
		expect(stopoverLengthLabel(1)).toBe('1 night');
	});

	it('is plural beyond that', () => {
		expect(stopoverLengthLabel(4)).toBe('4 nights');
	});
});

describe('stopoverLadder', () => {
	it('prices the example the owner was shown, second night included', () => {
		// The measurement that decided this issue's shape. BVC to PFO via London: one night
		// EUR 265.00, two nights EUR 262.00 on a different onward fare, three nights
		// EUR 289.00. Priced off the bed's EUR 13.00 nightly rate the second night would
		// have read +EUR 13.00. It is minus three.
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({ nights: 2, priceMinorUnits: 26_200 });
		const threeNights = itineraryWith({ nights: 3, priceMinorUnits: 28_900 });

		const ladder = stopoverLadder(
			oneNight,
			[option(oneNight), option(twoNights), option(threeNights)],
			'London'
		);

		expect(ladder.map((rung) => [rung.label, rung.delta])).toEqual([
			['1 night', undefined],
			['2 nights', '-€3.00'],
			['3 nights', '+€24.00']
		]);
	});

	it('marks the trip on screen and gives it no delta against itself', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({ nights: 2, priceMinorUnits: 26_200 });

		const ladder = stopoverLadder(oneNight, [option(oneNight), option(twoNights)], 'London');

		expect(ladder[0]).toMatchObject({ isCurrent: true, deltaMinorUnits: 0 });
		expect(ladder[0]?.delta).toBeUndefined();
		expect(ladder[1]?.isCurrent).toBe(false);
	});

	it('re-anchors on the trip on screen once the traveller has extended', () => {
		// The headline above the ladder is the trip currently shown (#230), so a rung's
		// delta added to it has to be what that rung costs. Anchored to the shortest
		// instead, standing on two nights would print "+EUR 24.00" beside a EUR 262.00
		// headline for a EUR 289.00 trip.
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({ nights: 2, priceMinorUnits: 26_200 });
		const threeNights = itineraryWith({ nights: 3, priceMinorUnits: 28_900 });

		const ladder = stopoverLadder(
			twoNights,
			[option(oneNight), option(twoNights), option(threeNights)],
			'London'
		);

		// And going back to one night really does cost three euros more, which is the whole
		// finding this issue was reshaped around.
		expect(ladder.map((rung) => rung.delta)).toEqual(['+€3.00', undefined, '+€27.00']);
	});

	it('says "same price" rather than "+€0.00" for a longer stay that costs the same', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({ nights: 2, priceMinorUnits: 26_500 });

		const ladder = stopoverLadder(oneNight, [option(oneNight), option(twoNights)], 'London');

		expect(ladder[1]?.delta).toBe('same price');
	});

	it('names the trip a button would produce, never the direction it points', () => {
		// A screen reader announcing "longer" tells the user which way the button goes and
		// nothing about where it lands, and where it lands is a different flight.
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({ nights: 2, priceMinorUnits: 26_200 });

		const ladder = stopoverLadder(oneNight, [option(oneNight), option(twoNights)], 'London');

		expect(ladder[0]?.description).toBe('1 night in London, the trip shown');
		expect(ladder[1]?.description).toBe('2 nights in London, -€3.00');
	});

	it('keeps the flight-change wording on a rung with no night in it', () => {
		const sameDay = itineraryWith({ nights: 0, priceMinorUnits: 22_000 });
		const overnight = itineraryWith({ nights: 1, priceMinorUnits: 28_000 });

		const ladder = stopoverLadder(sameDay, [option(sameDay), option(overnight)], 'London');

		expect(ladder[0]?.label).toBe('Flight change');
		expect(ladder[1]?.description).toBe('1 night in London, +€60.00');
	});
});

describe('describeLadderFlights', () => {
	it('says a different onward flight when only the onward leg moves', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({
			nights: 2,
			priceMinorUnits: 26_200,
			outbound: oneNight.outboundFlight,
			onward: { ...oneNight.onwardFlight, flightNumber: 'LATER1' }
		});
		const threeNights = itineraryWith({
			nights: 3,
			priceMinorUnits: 28_900,
			outbound: oneNight.outboundFlight,
			onward: { ...oneNight.onwardFlight, flightNumber: 'LATER2' }
		});

		expect(
			describeLadderFlights(oneNight, [option(oneNight), option(twoNights), option(threeNights)])
		).toBe('a different onward flight each time');
	});

	it('drops "each time" when there is only one other length', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({
			nights: 2,
			priceMinorUnits: 26_200,
			outbound: oneNight.outboundFlight,
			onward: { ...oneNight.onwardFlight, flightNumber: 'LATER1' }
		});

		expect(describeLadderFlights(oneNight, [option(oneNight), option(twoNights)])).toBe(
			'a different onward flight'
		);
	});

	it('widens to "different flights" as soon as an outbound moves too', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const twoNights = itineraryWith({
			nights: 2,
			priceMinorUnits: 26_200,
			outbound: oneNight.outboundFlight,
			onward: { ...oneNight.onwardFlight, flightNumber: 'LATER1' }
		});
		const threeNights = itineraryWith({
			nights: 3,
			priceMinorUnits: 28_900,
			outbound: { ...oneNight.outboundFlight, flightNumber: 'EARLY1' },
			onward: { ...oneNight.onwardFlight, flightNumber: 'LATER2' }
		});

		expect(
			describeLadderFlights(oneNight, [option(oneNight), option(twoNights), option(threeNights)])
		).toBe('different flights each time');
	});

	it('says nothing when the city offers one length', () => {
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });

		expect(describeLadderFlights(oneNight, [option(oneNight)])).toBeUndefined();
	});

	it('compares flights by carrier, number and departure, never by object identity', () => {
		// Svelte 5 deep-proxies `$state`, so the same offer read through `result.itinerary`
		// and through `result.stopover.options` arrives here as two different proxies.
		// Comparing by reference made every default card in production claim its flights
		// had changed when nothing had.
		const oneNight = itineraryWith({ nights: 1, priceMinorUnits: 26_500 });
		const sameTripAnotherProxy = structuredClone(oneNight);
		const twoNights = itineraryWith({
			nights: 2,
			priceMinorUnits: 26_200,
			outbound: structuredClone(oneNight.outboundFlight),
			onward: structuredClone(oneNight.onwardFlight)
		});

		expect(
			describeLadderFlights(sameTripAnotherProxy, [option(oneNight), option(twoNights)])
		).toBeUndefined();
	});
});

describe('a stopover that crosses a midnight it cannot sleep through (issue #231)', () => {
	/** Land 11pm, at the property by 11:30pm, leave for the airport at 2:30am. Three hours
	 * of night, which is the case the owner reported. */
	const overnightWait = makeItinerary({
		freeTimeStart: '2026-10-06T23:30:00',
		freeTimeEnd: '2026-10-07T02:30:00',
		freeTimeMinutes: 180,
		nightsInConnection: 0
	});

	/** Same zero nights, but the traveller never sees a midnight. */
	const sameDay = makeItinerary({
		freeTimeStart: '2026-10-06T10:00:00',
		freeTimeEnd: '2026-10-06T18:00:00',
		freeTimeMinutes: 480,
		nightsInConnection: 0
	});

	it('is not called a flight change', () => {
		expect(stopoverLengthLabelFor(overnightWait)).toBe('Overnight wait');
		expect(stopoverLengthLabelFor(sameDay)).toBe('Flight change');
	});

	it('still counts its nights when it has any', () => {
		expect(stopoverLengthLabelFor(makeItinerary({ nightsInConnection: 2 }))).toBe('2 nights');
	});

	it('says how long the wait is and why nothing is booked', () => {
		expect(overnightWaitNote(overnightWait)).toBe('Overnight wait, 3h, too short to be worth a bed');
	});

	it('says nothing at all about any other trip', () => {
		expect(overnightWaitNote(sameDay)).toBeUndefined();
		expect(overnightWaitNote(makeItinerary({ nightsInConnection: 1 }))).toBeUndefined();
	});

	it('names the rung a traveller would step up from', () => {
		// The ladder's shortest rung is the wait itself. Labelling it "Flight change" would
		// be the app describing a journey the traveller is not on.
		const twoNights = makeItinerary({
			freeTimeStart: '2026-10-06T23:30:00',
			freeTimeEnd: '2026-10-08T10:00:00',
			nightsInConnection: 2,
			priceMinorUnits: 15000
		});
		const rungs = stopoverLadder(twoNights, [
			{ nights: 0, itinerary: overnightWait },
			{ nights: 2, itinerary: twoNights }
		], 'London');

		expect(rungs[0].label).toBe('Overnight wait');
		expect(rungs[0].description).toContain('Overnight wait in London');
		expect(rungs[1].label).toBe('2 nights');
	});
});
