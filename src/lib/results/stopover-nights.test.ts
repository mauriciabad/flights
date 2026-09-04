import { describe, expect, it } from 'vitest';
import type { FlightOffer, Itinerary } from '$lib/domain';
import {
	describeLengthStep,
	describeStopoverChange,
	neighbouringLengths,
	stopoverLengthLabel
} from './stopover-nights';
import { makeScoredResult } from './test-support';

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

describe('describeStopoverChange', () => {
	it('reports nothing to explain while the card sits at its shortest length', () => {
		const minimum = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });

		const change = describeStopoverChange(minimum, minimum);

		expect(change).toMatchObject({ extraNights: 0, deltaMinorUnits: 0, changedFlights: 'none' });
		expect(change.note).toBeUndefined();
	});

	it('reports nothing when the two itineraries are equal but not the same object', () => {
		// Svelte 5 deep-proxies `$state`, so the same itinerary read through
		// `result.itinerary` and through `result.stopover.minimumItinerary` arrives here as
		// two different proxies. Comparing offers by reference made every default card in
		// production print "Same price, on different flights both ways".
		const minimum = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const throughAnotherProxy = structuredClone(minimum);

		expect(describeStopoverChange(throughAnotherProxy, minimum).note).toBeUndefined();
	});

	it('names the price move and the flight that moved with it', () => {
		// Issue #224: "Do not silently cap it either. If the traveller extends beyond what
		// the flight pairing supports, the onward flight has to change, and the card must
		// say the price moved and why."
		const minimum = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const laterOnward: FlightOffer = { ...minimum.onwardFlight, flightNumber: 'LATER1' };
		const extended = itineraryWith({
			nights: 2,
			priceMinorUnits: 32_300,
			outbound: minimum.outboundFlight,
			onward: laterOnward
		});

		const change = describeStopoverChange(extended, minimum);

		expect(change.extraNights).toBe(1);
		expect(change.deltaMinorUnits).toBe(4_100);
		expect(change.changedFlights).toBe('onward');
		expect(change.note).toBe('+€41.00 vs 1 night, on a different onward flight');
	});

	it('says both when a longer stay needs a different flight in each direction', () => {
		const minimum = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const extended = itineraryWith({
			nights: 3,
			priceMinorUnits: 30_000,
			outbound: { ...minimum.outboundFlight, flightNumber: 'EARLY1' },
			onward: { ...minimum.onwardFlight, flightNumber: 'LATER1' }
		});

		expect(describeStopoverChange(extended, minimum).changedFlights).toBe('both');
	});

	it('names the same-day flights as the baseline, not "flight change"', () => {
		// A city you can connect through in a day opens at zero nights (issue #225), so the
		// first night the traveller adds is compared against that trip. "+EUR 60.00 vs
		// flight change" reads as a fee; the words have to name the trip.
		const sameDay = itineraryWith({ nights: 0, priceMinorUnits: 22_000 });
		const overnight = itineraryWith({
			nights: 1,
			priceMinorUnits: 28_000,
			outbound: sameDay.outboundFlight,
			onward: { ...sameDay.onwardFlight, flightNumber: 'NEXTDAY1' }
		});

		expect(describeStopoverChange(overnight, sameDay).note).toBe(
			'+€60.00 vs the same-day flights, on a different onward flight'
		);
	});

	it('says so when a longer stay is not more expensive, rather than assuming a plus', () => {
		// A later onward flight is sometimes the cheaper fare. Hiding that behind an
		// assumed "+" would misreport the one number the traveller is deciding on.
		const minimum = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const extended = itineraryWith({
			nights: 2,
			priceMinorUnits: 26_000,
			outbound: minimum.outboundFlight,
			onward: { ...minimum.onwardFlight, flightNumber: 'CHEAP1' }
		});

		const change = describeStopoverChange(extended, minimum);

		expect(change.deltaMinorUnits).toBe(-2_200);
		expect(change.note).toBe('-€22.00 vs 1 night, on a different onward flight');
	});
});

describe('describeLengthStep', () => {
	it('prices one more night off the two real totals, fare change included', () => {
		// Issue #225 asks for "+x€per night". Taken from the bed's nightly rate it would
		// have read EUR 22 here; the pairing that buys the night also costs EUR 19 more in
		// fare, and EUR 41 is what the traveller actually pays.
		const shown = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const next = itineraryWith({ nights: 2, priceMinorUnits: 32_300 });

		expect(describeLengthStep(shown, next)).toBe('one more night, +€41.00');
	});

	it('describes a step back down as well, so both buttons speak the same language', () => {
		const shown = itineraryWith({ nights: 2, priceMinorUnits: 32_300 });
		const shorter = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });

		expect(describeLengthStep(shown, shorter)).toBe('one night fewer, -€41.00');
	});

	it('gives a per-night rate when the next rung moves several nights at once', () => {
		const shown = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const next = itineraryWith({ nights: 4, priceMinorUnits: 40_200 });

		expect(describeLengthStep(shown, next)).toBe('3 more nights, +€120.00 (€40.00 a night)');
	});

	it('says "same price" rather than printing a zero delta', () => {
		const shown = itineraryWith({ nights: 1, priceMinorUnits: 28_200 });
		const next = itineraryWith({ nights: 2, priceMinorUnits: 28_200 });

		expect(describeLengthStep(shown, next)).toBe('one more night, same price');
	});

	it('is undefined at the end of the ladder, which is what disables the button', () => {
		const shown = itineraryWith({ nights: 2, priceMinorUnits: 30_000 });

		expect(describeLengthStep(shown, undefined)).toBeUndefined();
	});
});

describe('neighbouringLengths', () => {
	it('finds the rungs either side of the current one', () => {
		expect(neighbouringLengths([1, 2, 4, 6], 2)).toEqual({ shorter: 1, longer: 4 });
	});

	it('has no shorter rung at the bottom, and no longer one at the top', () => {
		expect(neighbouringLengths([1, 3], 1)).toEqual({ shorter: undefined, longer: 3 });
		expect(neighbouringLengths([1, 3], 3)).toEqual({ shorter: 1, longer: undefined });
	});

	it('skips the gaps rather than inventing a length the city cannot do', () => {
		// A city with a 1-night and a 6-night pairing and nothing between offers exactly
		// those two. Stepping to "2" would be a trip no flight pairing supports.
		expect(neighbouringLengths([1, 6], 1)).toEqual({ shorter: undefined, longer: 6 });
	});
});
