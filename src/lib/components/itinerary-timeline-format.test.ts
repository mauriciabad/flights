import { describe, expect, it } from 'vitest';
import type { Duration, LocalDateTime, Transfer, TransferLeg } from '../domain';
import {
	formatCalendarDate,
	formatClockTime,
	formatDuration,
	formatMoney,
	formatMoneyDelta,
	formatMoneyRange,
	formatStraightLineKm,
	formatTimeDelta,
	formatUtcOffset,
	isDifferentCalendarDate,
	summariseTransferLegs,
	transferDetailLine,
	unpricedTransferNote,
	unroutedLegNote
} from './itinerary-timeline-format';

function localDateTime(local: string, timeZone: string, utcOffsetMinutes: number): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

describe('formatClockTime, overnight correctness', () => {
	it('reads a 00:30 arrival as 00:30, never shifted to the previous day by the machine timezone', () => {
		// Regression guard for exactly the bug AGENTS.md calls out: a 00:30 local arrival
		// must render as 00:30, not as whatever this instant happens to be in the machine
		// running the test (which is why this asserts the string, not a Date comparison).
		const arrival = localDateTime('2026-09-05T00:30:00', 'Europe/Vienna', 120);
		expect(formatClockTime(arrival)).toBe('00:30');
	});

	it('is unaffected by utcOffsetMinutes, only the local digits are ever read', () => {
		const sameWallClock = localDateTime('2026-09-05T00:30:00', 'Pacific/Auckland', 720);
		expect(formatClockTime(sameWallClock)).toBe('00:30');
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
	it('names both missing halves, in the direction the row is describing', () => {
		// Issue #161 gave these legs a second destination — the city centre — so "no bed,
		// therefore nowhere to go" stopped being the whole story. An empty row now means
		// neither a bed nor a city route, and the sentence states both rather than pinning
		// it on the bed alone.
		const overnight = { hasStay: false, nightsInConnection: 6 };
		expect(unroutedLegNote('to-hotel', overnight)).toBe(
			'No bed priced for this stopover, and nothing routed into the city either.'
		);
		expect(unroutedLegNote('from-hotel', overnight)).toBe(
			'No bed priced for this stopover, and nothing routed back from the city either.'
		);
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

	it('never says "yet" about a leg nothing is coming for (issue #140)', () => {
		const legs = ['to-hotel', 'from-hotel', 'to-origin-airport', 'to-destination-location'] as const;
		const contexts = [
			{ hasStay: false, nightsInConnection: 0 },
			{ hasStay: false, nightsInConnection: 6 },
			{ hasStay: true, nightsInConnection: 6 }
		];
		for (const leg of legs) {
			for (const context of contexts) {
				expect(unroutedLegNote(leg, context)).not.toMatch(/\byet\b/i);
			}
		}
	});
});

describe('unpricedTransferNote (issue #119)', () => {
	it('says a walk has no fare, which is a fact, not a missing number', () => {
		expect(unpricedTransferNote('walk')).toBe('No fare');
		expect(unpricedTransferNote('walk', true)).toBe('no fare');
	});

	it('says a paid mode with no quote is a gap in the data, not a free ride', () => {
		for (const mode of ['transit', 'taxi', 'drive'] as const) {
			expect(unpricedTransferNote(mode)).toBe('Price not available');
			expect(unpricedTransferNote(mode, true)).toBe('price n/a');
		}
	});

	it('never prints a zero for any mode, in either form', () => {
		// The owner's complaint in full: "price of walk is 0\u20ac". A zero next to real
		// fares invites a comparison the number cannot support, whatever the mode.
		for (const mode of ['walk', 'transit', 'taxi', 'drive'] as const) {
			expect(unpricedTransferNote(mode)).not.toMatch(/0/);
			expect(unpricedTransferNote(mode, true)).not.toMatch(/0/);
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

describe('formatStraightLineKm', () => {
	it('rounds to whole kilometres, with a space that cannot break', () => {
		expect(formatStraightLineKm(9.7)).toBe('10\u00a0km');
		expect(formatStraightLineKm(48.9)).toBe('49\u00a0km');
	});

	it('keeps a decimal under a kilometre, where rounding to zero would read as nonsense', () => {
		expect(formatStraightLineKm(0.42)).toBe('0.4\u00a0km');
	});
});
