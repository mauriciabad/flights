import { describe, expect, it } from 'vitest';
import type { Duration, LocalDateTime, Transfer, TransferLeg } from '../domain';
import {
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatMoney,
	formatMoneyDelta,
	formatMoneyRange,
	formatKilometres,
	formatTimeDelta,
	formatUtcOffset,
	isDifferentCalendarDate,
	landingBufferFootnote,
	landingBufferNote,
	landingBufferPickerNote,
	staleScheduleFact,
	staleScheduleNote,
	summariseTransferLegs,
	transferDetailLine,
	transferFareNote,
	transitDepartureWaitNote,
	unroutedLegNote
} from './itinerary-timeline-format';

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

describe('formatClockTime, overnight correctness', () => {
	it('reads a 00:30 arrival as half past midnight, never shifted by the machine timezone', () => {
		// Regression guard for exactly the bug AGENTS.md calls out: a 00:30 local arrival
		// must render as half past midnight, not as whatever this instant happens to be in
		// the machine running the test (which is why this asserts the string, not a Date
		// comparison). Issue #229 also makes it the hour a naive am/pm formatter writes as
		// "0:30am": `hour % 12` is 0 at midnight and the clock face says 12.
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Vienna', 120);
		expect(formatClockTime(arrival)).toBe('12:30am');
	});

	it('is unaffected by utcOffsetMinutes, only the local digits are ever read', () => {
		const sameWallClock = localDateTime('2026-09-05T00:30:00', 'Pacific/Auckland', 720);
		expect(formatClockTime(sameWallClock)).toBe('12:30am');
	});
});

describe('formatCalendarDate, overnight correctness', () => {
	it('renders the departure date and the next-day arrival date as different, correct dates', () => {
		const departure = localDateTime('2026-09-04T22:15:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Istanbul', 180);

		expect(formatCalendarDate(departure)).toBe('Fri, 4 Sep');
		expect(formatCalendarDate(arrival)).toBe('Sat, 5 Sep');
		expect(formatCalendarDate(departure)).not.toBe(formatCalendarDate(arrival));
	});
});

describe('isDifferentCalendarDate', () => {
	it('is true across an overnight flight', () => {
		const departure = localDateTime('2026-09-04T22:15:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Istanbul', 180);
		expect(isDifferentCalendarDate(departure, arrival)).toBe(true);
	});

	it('is false for a same-day flight', () => {
		const departure = localDateTime('2026-09-04T08:00:00', 'Europe/Vienna', 120);
		const arrival = localDateTime('2026-09-04T09:30:00', 'Europe/Istanbul', 180);
		expect(isDifferentCalendarDate(departure, arrival)).toBe(false);
	});
});

describe('formatUtcOffset', () => {
	it('formats a positive whole-hour offset', () => {
		expect(formatUtcOffset(120)).toBe('UTC+2');
	});

	it('formats a negative offset', () => {
		expect(formatUtcOffset(-300)).toBe('UTC-5');
	});

	it('formats a half-hour offset', () => {
		expect(formatUtcOffset(330)).toBe('UTC+5:30');
	});

	it('formats zero as UTC+0', () => {
		expect(formatUtcOffset(0)).toBe('UTC+0');
	});
});

describe('formatDuration', () => {
	it('formats hours and minutes together', () => {
		expect(formatDuration(150 as Duration)).toBe('2h 30m');
	});

	it('drops the minutes when there are none', () => {
		expect(formatDuration(180 as Duration)).toBe('3h');
	});

	it('drops the hours when there are none', () => {
		expect(formatDuration(45 as Duration)).toBe('45m');
	});

	it('renders zero as 0m rather than an empty string', () => {
		expect(formatDuration(0 as Duration)).toBe('0m');
	});
});

describe('formatMoney', () => {
	it('divides EUR minor units by 100', () => {
		expect(formatMoney({ minorUnits: 12345, currency: 'EUR' })).toBe('€123.45');
	});

	it('does not divide JPY, a zero-decimal currency', () => {
		expect(formatMoney({ minorUnits: 1500, currency: 'JPY' })).toBe('¥1,500');
	});
});

describe('formatMoneyDelta', () => {
	it('reads "same price" for a zero delta rather than "+€0.00"', () => {
		expect(formatMoneyDelta(0, 'EUR')).toBe('same price');
	});

	it('signs a positive delta', () => {
		expect(formatMoneyDelta(1200, 'EUR')).toBe('+€12.00');
	});

	it('signs a negative delta with a minus, not the raw negative number', () => {
		expect(formatMoneyDelta(-800, 'EUR')).toBe('-€8.00');
	});
});

describe('formatMoneyRange', () => {
	it('renders both bounds, never collapsing a taxi estimate to one figure', () => {
		expect(formatMoneyRange(1800, 2400, 'EUR')).toBe('€18.00-€24.00');
	});
});

describe('formatTimeDelta', () => {
	it('reads "same time" for a zero delta', () => {
		expect(formatTimeDelta(0)).toBe('same time');
	});

	it('reads "later" for a positive delta, matching the brief\'s own "40 minutes later" example', () => {
		expect(formatTimeDelta(40)).toBe('40m later');
	});

	it('reads "earlier" for a negative delta', () => {
		expect(formatTimeDelta(-75)).toBe('1h 15m earlier');
	});

	it('accepts custom later/earlier wording', () => {
		expect(formatTimeDelta(15, 'after you land', 'before you land')).toBe('15m after you land');
	});
});

describe('unroutedLegNote', () => {
	it('states the row\'s own fact, in the direction the row is describing', () => {
		// Issue #161 gave these legs a second destination — the city centre — so "no bed,
		// therefore nowhere to go" stopped being the whole story. Issue #185 then took the
		// bed clause back out: it was true, and it was also the third and sixth of seven
		// places on one screen saying the same thing. The reason a bed is missing now lives
		// once, in the stopover row's own fold.
		const overnight = { hasStay: false, nightsInConnection: 6 };
		expect(unroutedLegNote('to-hotel', overnight)).toBe('Nothing routed into the city for this stopover.');
		expect(unroutedLegNote('from-hotel', overnight)).toBe(
			'Nothing routed back from the city for this stopover.'
		);
	});

	// Anchored on the fact rather than the prose: a check that greps for one sentence passes
	// vacuously the day somebody rewords it. Whatever these rows say, they must not be the
	// place that explains the bed — that is the stopover fold's one job now (#185).
	it('never repeats the missing bed, whatever the wording becomes', () => {
		for (const leg of ['to-hotel', 'from-hotel'] as const) {
			expect(unroutedLegNote(leg, { hasStay: false, nightsInConnection: 6 })).not.toMatch(/bed/i);
		}
	});

	it('says a same-day connection has no hotel leg at all, rather than one that has not arrived', () => {
		const sameDay = { hasStay: false, nightsInConnection: 0 };
		expect(unroutedLegNote('to-hotel', sameDay)).toBe(
			'Same-day connection, so there is no hotel leg here.'
		);
		expect(unroutedLegNote('from-hotel', sameDay)).toBe(
			'Same-day connection, so there is no hotel leg here.'
		);
	});

	it('says the same thing when the search quoted a bed the trip does not book', () => {
		// Issue #365. `build.ts` takes the two legs off a nightless stopover BECAUSE no night
		// is spent here, and the bed stays on as the quote it always was. Production printed
		// "The bed is priced, but no transport provider could route to it" over a metro route
		// the app had found and then correctly discarded, which blames a provider for a
		// decision this app made.
		const overnightWithQuote = { hasStay: true, nightsInConnection: 0, overnightWait: true };
		expect(unroutedLegNote('to-hotel', overnightWithQuote)).toBe(
			'Overnight wait, so there is no hotel leg here.'
		);
		expect(unroutedLegNote('from-hotel', overnightWithQuote)).toBe(
			'Overnight wait, so there is no hotel leg here.'
		);
	});

	it('outranks the picked-property sentence, because no night means no leg either way', () => {
		// A traveller can still open the stay picker on a stopover that carries a quote, so
		// `unrouted-stay` and zero nights can meet. "Nothing routed to this property" would be
		// answering a question nobody asked: the trip books no night, so it has no hotel leg
		// to route at all.
		expect(
			unroutedLegNote('to-hotel', {
				hasStay: true,
				nightsInConnection: 0,
				transferAnchor: 'unrouted-stay'
			})
		).toBe('Same-day connection, so there is no hotel leg here.');
	});

	it('reports an empty outer leg as providers answering with nothing, which is what happened', () => {
		// These two are gated on the query carrying a location, not on a stay, and their
		// rows only render when it does — so reaching here means a request was made.
		const context = { hasStay: false, nightsInConnection: 6 };
		expect(unroutedLegNote('to-origin-airport', context)).toBe(
			'No route came back from the transport providers for this leg.'
		);
		expect(unroutedLegNote('to-destination-location', context)).toBe(
			'No route came back from the transport providers for this leg.'
		);
	});

	it('separates a bed nobody has routed to from one no provider could reach (issue #243)', () => {
		const picked = { hasStay: true, nightsInConnection: 1, transferAnchor: 'unrouted-stay' as const };
		expect(unroutedLegNote('to-hotel', picked)).toBe(
			'Nothing routed to this property, so the journey to it is unknown.'
		);
		expect(unroutedLegNote('from-hotel', picked)).toBe(
			'Nothing routed back from this property, so the journey back is unknown.'
		);

		// The sentence this replaces, still reached when the search DID ask about this
		// address and no provider could answer (issue #211). Blaming a provider for a
		// question nobody put to it is the AGENTS.md failure these two must not share.
		const refused = { hasStay: true, nightsInConnection: 1 };
		expect(unroutedLegNote('to-hotel', refused)).toBe(
			'The bed is priced, but no transport provider could route to it.'
		);
		expect(unroutedLegNote('to-hotel', picked)).not.toMatch(/provider/i);
	});

	it('says a road route was refused rather than that nobody could route it (issue #119)', () => {
		// Athens airport to Naxos town, the measured case behind `maxPlausibleRoadMinutes`.
		// Every other sentence in this function claims nothing was routed, and here something
		// was: OSRM answered, at 33h, and this app is what declined to offer it.
		const withheld = { road: { count: 2, quickest: 1980 as Duration, straightLineKm: 156.6 } };

		expect(unroutedLegNote('to-hotel', { hasStay: true, nightsInConnection: 1, withheld })).toBe(
			'The road route in takes 33h to cover 157 km in a straight line, so it is not offered.'
		);
		// And with no bed priced either, where the row would otherwise say "Nothing routed
		// into the city for this stopover" about a route that came back.
		expect(unroutedLegNote('to-hotel', { hasStay: false, nightsInConnection: 1, withheld })).toBe(
			'The road route in takes 33h to cover 157 km in a straight line, so it is not offered.'
		);
		expect(
			unroutedLegNote('to-destination-location', { hasStay: false, nightsInConnection: 6, withheld })
		).toBe('The road route takes 33h to cover 157 km in a straight line, so it is not offered.');
	});

	it('does not print how many routes it refused, because drive and taxi are one route', () => {
		// OSRM answers both from the same driving lookup, so the count is all but always 2 and
		// "2 routes" would describe two options where the traveller has one.
		const note = unroutedLegNote('from-hotel', {
			hasStay: true,
			nightsInConnection: 1,
			withheld: { road: { count: 2, quickest: 1980 as Duration, straightLineKm: 156.6 } }
		});
		expect(note).not.toMatch(/\b2\b/);
		expect(note).toBe('The road route back takes 33h to cover 157 km in a straight line, so it is not offered.');
	});

	it('says a walk was refused rather than that nobody could route it (issue #347)', () => {
		// Gatwick's own numbers before #348: the published airport point is 1.4 km from the
		// terminal with a runway between them, so a 32-minute walk routed as 1h 13m and was
		// dropped. 653 airports have no terminal in OpenStreetMap for #348 to move onto, so
		// this still happens, and the two numbers side by side are what let a traveller see
		// the walk was measured from the wrong place.
		const withheld = { walk: { count: 1, quickest: 73 as Duration, straightLineKm: 1.4 } };

		expect(unroutedLegNote('to-hotel', { hasStay: true, nightsInConnection: 1, withheld })).toBe(
			'The walk in takes 1h 13m to cover 1 km in a straight line, so it is not offered.'
		);
		expect(unroutedLegNote('from-hotel', { hasStay: true, nightsInConnection: 1, withheld })).toBe(
			'The walk back takes 1h 13m to cover 1 km in a straight line, so it is not offered.'
		);
		expect(
			unroutedLegNote('to-origin-airport', { hasStay: false, nightsInConnection: 0, withheld })
		).toBe('The walk takes 1h 13m to cover 1 km in a straight line, so it is not offered.');
	});

	it('leads with the refused drive when both were refused', () => {
		// A walk over 45 minutes is what a drive of 33 hours implies, so printing both would
		// spend the second clause restating the first.
		const note = unroutedLegNote('to-hotel', {
			hasStay: true,
			nightsInConnection: 1,
			withheld: {
				road: { count: 2, quickest: 1980 as Duration, straightLineKm: 156.6 },
				walk: { count: 1, quickest: 2400 as Duration, straightLineKm: 156.6 }
			}
		});
		expect(note).toBe('The road route in takes 33h to cover 157 km in a straight line, so it is not offered.');
	});

	it('lets a property nobody routed win over a refusal about a different one', () => {
		// Both facts can be true at once and they are about different addresses. `withheld`
		// describes the leg the SEARCH routed, to the property the search picked; once the
		// traveller has moved to another one, `transferAnchor` is 'unrouted-stay' and that
		// refusal is about somewhere they are no longer looking at. Printing it here would be
		// issue #243's wrong-address bug arriving from the other direction, so the ordering in
		// `unroutedLegNote` is load-bearing and this is what fails when somebody swaps it.
		const both = {
			hasStay: true,
			nightsInConnection: 1,
			transferAnchor: 'unrouted-stay' as const,
			withheld: { road: { count: 2, quickest: 1980 as Duration, straightLineKm: 156.6 } }
		};

		expect(unroutedLegNote('to-hotel', both)).toBe(
			'Nothing routed to this property, so the journey to it is unknown.'
		);
		expect(unroutedLegNote('from-hotel', both)).toBe(
			'Nothing routed back from this property, so the journey back is unknown.'
		);
		expect(unroutedLegNote('to-hotel', both)).not.toMatch(/33h/);
	});

	it('leaves a nightless connection alone, since there is no hotel leg to route to', () => {
		// The refusal is true and irrelevant: this traveller is not going to a bed at all, and
		// the same-day sentence is what they need to read.
		expect(
			unroutedLegNote('to-hotel', {
				hasStay: false,
				nightsInConnection: 0,
				withheld: { road: { count: 2, quickest: 1980 as Duration, straightLineKm: 156.6 } }
			})
		).toBe('Same-day connection, so there is no hotel leg here.');
	});

	it('never says "yet" about a leg nothing is coming for (issue #140)', () => {
		const legs = ['to-hotel', 'from-hotel', 'to-origin-airport', 'to-destination-location'] as const;
		const contexts = [
			{ hasStay: false, nightsInConnection: 0 },
			{ hasStay: false, nightsInConnection: 6 },
			{ hasStay: true, nightsInConnection: 6 },
			{ hasStay: true, nightsInConnection: 1, transferAnchor: 'unrouted-stay' as const }
		];
		for (const leg of legs) {
			for (const context of contexts) {
				expect(unroutedLegNote(leg, context)).not.toMatch(/\byet\b/i);
			}
		}
	});
});

describe('transferFareNote (issues #119, #249)', () => {
	function ride(mode: Transfer['mode'], extra: Partial<Transfer> = {}): Transfer {
		return { mode, duration: 20 as Duration, legs: [], ...extra };
	}

	it('says a walk has no fare, which is a fact, not a missing number', () => {
		expect(transferFareNote(ride('walk'))).toEqual({
			text: 'No fare',
			amount: false,
			estimated: false,
			unknown: false
		});
		expect(transferFareNote(ride('walk'), true).text).toBe('no fare');
	});

	it('says a paid mode with no quote is a gap in the data, not a free ride', () => {
		for (const mode of ['transit', 'taxi', 'drive'] as const) {
			expect(transferFareNote(ride(mode))).toEqual({
				text: 'Price not available',
				amount: false,
				estimated: false,
				unknown: true
			});
			expect(transferFareNote(ride(mode), true).text).toBe('price n/a');
		}
	});

	it('prints a rate-card range as an amount, marked as a guess rather than greyed out', () => {
		// The defect that made this take a Transfer instead of a mode: measured on a live
		// build on 2026-09-05, `StopoverBlock` read "Taxi, 36m from the airport, price not
		// available" a few centimetres under a receipt line reading "£35.85-£55.58 ESTIMATE"
		// for that same ride.
		const rated = ride('taxi', {
			fareEstimate: {
				kind: 'estimate',
				currency: 'GBP',
				lowMinorUnits: 3585,
				highMinorUnits: 5558,
				countryCode: 'GB',
				rateSource: 'country',
				citation: 'London black-cab Tariff 1'
			}
		});
		expect(transferFareNote(rated)).toEqual({
			text: '£35.85-£55.58',
			amount: true,
			estimated: true,
			unknown: false
		});
	});

	it("keeps issue #246's refusal distinct from nobody having asked", () => {
		const beyond = ride('taxi', {
			fareEstimate: {
				kind: 'out-of-range',
				distanceKm: 94.9,
				ratedUpToKm: 30,
				countryCode: 'GB',
				citation: 'London black-cab Tariff 1'
			}
		});
		expect(transferFareNote(beyond)).toEqual({
			text: 'No fare estimate',
			amount: false,
			estimated: false,
			unknown: true
		});
		expect(transferFareNote(beyond, true).text).toBe('no estimate');
	});

	it('prefers a real quote over an estimate, and never marks it as one', () => {
		const quoted = ride('transit', { price: { minorUnits: 450, currency: 'EUR' } });
		expect(transferFareNote(quoted)).toEqual({
			text: '€4.50',
			amount: true,
			estimated: false,
			unknown: false
		});
	});

	it('names the party and the share when the ride was rated for one (issue #344)', () => {
		const forFour = ride('taxi', {
			fareEstimate: {
				kind: 'estimate',
				currency: 'EUR',
				lowMinorUnits: 6000,
				highMinorUnits: 8000,
				countryCode: 'FR',
				rateSource: 'country',
				citation: 'French national per-km ceiling',
				party: {
					basis: 'per-vehicle',
					people: 4,
					vehicles: 1,
					perVehicleLowMinorUnits: 6000,
					perVehicleHighMinorUnits: 8000,
					perPersonLowMinorUnits: 1500,
					perPersonHighMinorUnits: 2000
				}
			}
		});
		expect(transferFareNote(forFour)).toEqual({
			text: '\u20ac60.00-\u20ac80.00',
			amount: true,
			estimated: true,
			unknown: false,
			audience: 'for 4',
			each: '\u20ac15.00-\u20ac20.00 each'
		});
	});

	it('counts the cars in the audience rather than hiding a second one (issue #344)', () => {
		const forFive = ride('taxi', {
			fareEstimate: {
				kind: 'estimate',
				currency: 'EUR',
				lowMinorUnits: 12_000,
				highMinorUnits: 16_000,
				countryCode: 'FR',
				rateSource: 'country',
				citation: 'French national per-km ceiling',
				party: {
					basis: 'per-vehicle',
					people: 5,
					vehicles: 2,
					perVehicleLowMinorUnits: 6000,
					perVehicleHighMinorUnits: 8000,
					perPersonLowMinorUnits: 2400,
					perPersonHighMinorUnits: 3200
				}
			}
		});
		expect(transferFareNote(forFive).audience).toBe('for 5 in 2 taxis');
		expect(transferFareNote(forFive).each).toBe('\u20ac24.00-\u20ac32.00 each');
	});

	it('refuses to word a split it is not licensed to make (issue #344)', () => {
		// The fallback rate card. Whether a taxi in an unlisted country charges by the car or
		// by the seat is exactly what having no card means, so the row says the figure and
		// nothing about heads.
		const unchecked = ride('taxi', {
			fareEstimate: {
				kind: 'estimate',
				currency: 'EUR',
				lowMinorUnits: 4000,
				highMinorUnits: 9000,
				countryCode: 'ZZ',
				rateSource: 'fallback',
				citation: 'No rate card for this country.',
				party: { basis: 'unknown', people: 4 }
			}
		});
		expect(transferFareNote(unchecked).audience).toBeUndefined();
		expect(transferFareNote(unchecked).each).toBeUndefined();
		expect(transferFareNote(unchecked).text).toBe('\u20ac40.00-\u20ac90.00');
	});

	it('never prints a bare zero for any mode, in either form', () => {
		// The owner's complaint in full: "price of walk is 0\u20ac". A zero next to real
		// fares invites a comparison the number cannot support, whatever the mode.
		for (const mode of ['walk', 'transit', 'taxi', 'drive'] as const) {
			expect(transferFareNote(ride(mode)).text).not.toMatch(/0/);
			expect(transferFareNote(ride(mode), true).text).not.toMatch(/0/);
		}
	});
});

describe('summariseTransferLegs (issue #220)', () => {
	function ride(vehicle: string | undefined, minutes = 20): TransferLeg {
		return { mode: 'transit', vehicle, duration: minutes as Duration };
	}
	const walk: TransferLeg = { mode: 'walk', description: 'Walk (0 m)', duration: 2 as Duration };

	it('replaces the brick with what you ride and how often you change', () => {
		// What the row printed before, in full: "Walk (0 m), Transit OLB-BHX to Aeroporto di
		// Olbia (OLB) (JET TWO COM), Walk (0 m), Transit OLB-FCO to ...".
		expect(summariseTransferLegs([walk, ride('Metro'), walk, ride('Bus'), walk])).toBe(
			'Metro, then bus (1 change)'
		);
	});

	it('says nothing about changes when there is one ride to make', () => {
		expect(summariseTransferLegs([walk, ride('Coach'), walk])).toBe('Coach');
	});

	it('counts rides rather than naming them once naming them stops being a summary', () => {
		expect(summariseTransferLegs([ride('Bus'), ride('Train'), ride('Coach'), ride('Bus')])).toBe(
			'4 rides (3 changes)'
		);
	});

	it('counts them when a provider did not name the vehicle, instead of printing a hole', () => {
		// A `Transfer` cached before `TransferLeg.vehicle` existed reaches this with every
		// vehicle undefined.
		expect(summariseTransferLegs([walk, ride(undefined), walk, ride(undefined)])).toBe(
			'2 rides (1 change)'
		);
	});

	it('has nothing to summarise for a journey that is only walking', () => {
		expect(summariseTransferLegs([walk, walk])).toBeUndefined();
		expect(summariseTransferLegs([])).toBeUndefined();
	});

	it('does not call a taxi or a drive a ride, since "Taxi" says more than "1 ride"', () => {
		// Measured on the built app before this rule existed: an OSRM taxi transfer has one
		// leg, and the row read "To Birmingham Central Backpackers · 1 ride", having thrown
		// away the one word that mattered.
		expect(summariseTransferLegs([{ mode: 'taxi', duration: 54 as Duration }])).toBeUndefined();
		expect(summariseTransferLegs([{ mode: 'drive', duration: 54 as Duration }])).toBeUndefined();
	});
});

describe('transferDetailLine', () => {
	it('names the vehicles when a provider gave them', () => {
		const transfer: Transfer = {
			mode: 'transit',
			duration: 45 as Duration,
			legs: [{ mode: 'transit', vehicle: 'Train', duration: 45 as Duration }]
		};
		expect(transferDetailLine(transfer)).toBe('Train');
	});

	it('falls back to the mode, which is the whole truth for a walk or a drive', () => {
		expect(transferDetailLine({ mode: 'walk', duration: 12 as Duration, legs: [] })).toBe('Walk');
		expect(transferDetailLine({ mode: 'drive', duration: 18 as Duration, legs: [] })).toBe('Drive');
		// OSRM returns no legs at all, and Transitous answers cached before issue #220 have
		// legs with no vehicle on them.
		expect(transferDetailLine({ mode: 'transit', duration: 30 as Duration, legs: [] })).toBe(
			'Public transport'
		);
	});
});

describe('formatKilometres', () => {
	it('rounds to whole kilometres, with a space that cannot break', () => {
		expect(formatKilometres(9.7)).toBe('10\u00a0km');
		expect(formatKilometres(48.9)).toBe('49\u00a0km');
	});

	it('keeps a decimal under a kilometre, where rounding to zero would read as nonsense', () => {
		expect(formatKilometres(0.42)).toBe('0.4\u00a0km');
	});
});

describe('staleScheduleNote and staleScheduleFact, issue #266', () => {
	const madrid = (local: string) => localDateTime(local, 'Europe/Madrid', 120);

	it('names the new deadline on a leg that ends at a departure gate', () => {
		expect(
			staleScheduleNote({ time: madrid('2026-10-06T13:20:00'), arriveBy: true }, madrid('2026-10-06T03:40:00'))
		).toBe(
			'Timetable planned for 1:20pm, and you now need to be there by 3:40am, ' +
				'so these departures are not the ones to catch.'
		);
	});

	it('names the new landing on a leg that starts at a runway, never a deadline', () => {
		// The wording has to flip with the leg. Telling somebody who has just landed that
		// they need to "be there by" 1:30pm describes a bus they were never catching.
		expect(
			staleScheduleNote({ time: madrid('2026-10-06T11:30:00'), arriveBy: false }, madrid('2026-10-06T13:30:00'))
		).toBe(
			'Timetable planned for 11:30am, and you now leave the airport at 1:30pm, ' +
				'so these departures are not the ones to catch.'
		);
	});

	it('drops the consequence for a stub, where the label already asks the question', () => {
		expect(
			staleScheduleFact({ time: madrid('2026-10-06T11:30:00'), arriveBy: false }, madrid('2026-10-06T13:30:00'))
		).toBe('Planned for 11:30am, and you now leave the airport at 1:30pm');
		expect(
			staleScheduleFact({ time: madrid('2026-10-06T13:20:00'), arriveBy: true }, madrid('2026-10-06T03:40:00'))
		).toBe('Planned for 1:20pm, and you now need to be there by 3:40am');
	});
});

describe('the landing buffer, said out loud (issue #290)', () => {
	const taxi = (duration: number, landingBuffer?: number): Transfer => ({
		mode: 'taxi',
		duration: duration as Duration,
		landingBuffer: landingBuffer as Duration | undefined,
		legs: []
	});

	it('names the buffer, whose it is, and what the row still adds up to', () => {
		expect(landingBufferNote(taxi(68, 30))).toBe(
			'Plus your own 30m to get out of the airport, so you arrive 1h 8m after landing.'
		);
	});

	it('says nothing about a leg with no buffer, including a rule the traveller set to zero', () => {
		// Both are rows where the ride and the row duration are already the same number, so
		// there is nothing for this sentence to reconcile. A "plus your own 0m" would appear
		// on every leg that ends at a gate.
		expect(landingBufferNote(taxi(38))).toBeUndefined();
		expect(landingBufferNote(taxi(38, 0))).toBeUndefined();
	});

	it('borrows the airport wait stub own words, so two traveller-set buffers read alike', () => {
		expect(landingBufferFootnote(taxi(68, 30))).toBe(
			'Your own buffer, not a measured queue. 30m is the Landing to transport setting for an airport this size, and the search form is where you change it.'
		);
		expect(landingBufferFootnote(taxi(38, 0))).toBeUndefined();
	});
});

describe('the buffer a whole picker shares (issue #290)', () => {
	it('claims "every option" only about a list that agrees', () => {
		expect(landingBufferPickerNote(30 as Duration)).toBe(
			'Every option here starts 30m after you land, which is your own landing-to-transport setting. ' +
				'The times below are the journeys themselves.'
		);
	});

	it('says nothing when there is no shared padding to disclose', () => {
		expect(landingBufferPickerNote(0 as Duration)).toBeUndefined();
		expect(landingBufferPickerNote(undefined)).toBeUndefined();
	});
});

describe('transitDepartureWaitNote (issue #344)', () => {
	const intended = localDateTime('2026-10-07T05:49:00', 'Europe/London', 60);

	it('names the hour and how long after landing it is', () => {
		// #282's own example, which that PR flagged and left: a press replaced a 35-minute
		// taxi with a bus at 5:49am, nine hours after the traveller lands.
		expect(transitDepartureWaitNote(540 as Duration, intended)).toBe(
			'First departure 5:49am, 9h after you land.'
		);
	});

	it('stays quiet about a wait the traveller would have had anyway', () => {
		// A headway, not a dead spot. Saying it on every transit row in the app would bury the
		// one row where it matters.
		expect(transitDepartureWaitNote(20 as Duration, intended)).toBeUndefined();
		expect(transitDepartureWaitNote(0 as Duration, intended)).toBeUndefined();
	});

	it('says nothing when there is no wait to speak of', () => {
		expect(transitDepartureWaitNote(undefined, intended)).toBeUndefined();
	});
});
