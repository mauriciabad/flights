import { describe, expect, it } from 'vitest';
import {
	armTarget,
	describeDay,
	INITIAL_PAINT,
	markDay,
	paintDay,
	previewWindows,
	rangeLabel,
	resolveWindows,
	spanLength,
	visibleMonths,
	type DateWindowFields
} from './date-window';

function fields(partial: Partial<DateWindowFields> = {}): DateWindowFields {
	return {
		soonestDeparture: '',
		latestDepartureOverride: '',
		latestArrival: '',
		soonestArrivalOverride: '',
		...partial
	};
}

const MARCH = fields({ soonestDeparture: '2027-03-06', latestArrival: '2027-03-20' });

describe('resolveWindows', () => {
	it('spreads both windows across the whole span until they are narrowed', () => {
		expect(resolveWindows(MARCH)).toEqual({
			departFrom: '2027-03-06',
			departTo: '2027-03-20',
			arriveFrom: '2027-03-06',
			arriveTo: '2027-03-20'
		});
	});

	it('follows the overrides once they are set', () => {
		const narrowed = { ...MARCH, latestDepartureOverride: '2027-03-08', soonestArrivalOverride: '2027-03-18' };
		expect(resolveWindows(narrowed)).toEqual({
			departFrom: '2027-03-06',
			departTo: '2027-03-08',
			arriveFrom: '2027-03-18',
			arriveTo: '2027-03-20'
		});
	});
});

describe('markDay', () => {
	const narrowed = resolveWindows({
		...MARCH,
		latestDepartureOverride: '2027-03-08',
		soonestArrivalOverride: '2027-03-18'
	});

	it('caps each window at its own ends', () => {
		expect(markDay('2027-03-06', narrowed).depart).toBe('start');
		expect(markDay('2027-03-07', narrowed).depart).toBe('middle');
		expect(markDay('2027-03-08', narrowed).depart).toBe('end');
		expect(markDay('2027-03-18', narrowed).arrive).toBe('start');
		expect(markDay('2027-03-20', narrowed).arrive).toBe('end');
	});

	it('marks the days between the two windows as inside the span and on neither rail', () => {
		const middle = markDay('2027-03-12', narrowed);
		expect(middle).toMatchObject({ depart: 'none', arrive: 'none', inSpan: true });
	});

	it('draws both rails on a day the two windows overlap', () => {
		const overlapping = resolveWindows(MARCH);
		expect(markDay('2027-03-12', overlapping)).toMatchObject({
			depart: 'middle',
			arrive: 'middle',
			inSpan: true
		});
	});

	it('calls a one-day window "only" rather than a start with no end', () => {
		const oneDay = resolveWindows(fields({ soonestDeparture: '2027-03-06', latestArrival: '2027-03-06' }));
		expect(markDay('2027-03-06', oneDay)).toMatchObject({ depart: 'only', arrive: 'only' });
	});

	it('draws nothing at all while the span is still empty', () => {
		const empty = resolveWindows(fields());
		expect(markDay('2027-03-06', empty)).toMatchObject({
			depart: 'none',
			arrive: 'none',
			inSpan: false
		});
	});

	it('draws nothing when the two ends are the wrong way round, rather than inverting them', () => {
		const backwards = resolveWindows(fields({ soonestDeparture: '2027-03-20', latestArrival: '2027-03-06' }));
		expect(markDay('2027-03-10', backwards).depart).toBe('none');
	});
});

describe('describeDay', () => {
	const narrowed = resolveWindows({
		...MARCH,
		latestDepartureOverride: '2027-03-08',
		soonestArrivalOverride: '2027-03-18'
	});

	it('says which of the two windows a day belongs to', () => {
		expect(describeDay(markDay('2027-03-07', narrowed))).toBe('7 Mar 2027, you could leave');
		expect(describeDay(markDay('2027-03-19', narrowed))).toBe('19 Mar 2027, you could arrive');
		expect(describeDay(markDay('2027-03-12', narrowed))).toBe('12 Mar 2027, away');
		expect(describeDay(markDay('2027-03-12', resolveWindows(MARCH)))).toBe(
			'12 Mar 2027, you could leave and you could arrive'
		);
	});

	it('says only the date for a day outside the search', () => {
		expect(describeDay(markDay('2027-04-01', narrowed))).toBe('1 Apr 2027');
	});
});

describe('paintDay', () => {
	it('sets both ends of the span on the first tap, so one tap is already a valid search', () => {
		const painted = paintDay(fields(), INITIAL_PAINT, '2027-03-06');
		expect(painted.fields.soonestDeparture).toBe('2027-03-06');
		expect(painted.fields.latestArrival).toBe('2027-03-06');
		expect(painted.state).toEqual({ target: 'span', anchor: '2027-03-06' });
	});

	it('completes the span on the second tap and arms the departure cut', () => {
		const first = paintDay(fields(), INITIAL_PAINT, '2027-03-06');
		const second = paintDay(first.fields, first.state, '2027-03-20');
		expect(second.fields).toMatchObject({
			soonestDeparture: '2027-03-06',
			latestArrival: '2027-03-20'
		});
		expect(second.state).toEqual({ target: 'latestDeparture', anchor: undefined });
	});

	it('orders the span by date, not by which end was tapped first', () => {
		const first = paintDay(fields(), INITIAL_PAINT, '2027-03-20');
		const second = paintDay(first.fields, first.state, '2027-03-06');
		expect(second.fields).toMatchObject({
			soonestDeparture: '2027-03-06',
			latestArrival: '2027-03-20'
		});
	});

	it('narrows the departure window with one tap and moves on to the arrival one', () => {
		const painted = paintDay(MARCH, armTarget('latestDeparture'), '2027-03-08');
		expect(painted.fields.latestDepartureOverride).toBe('2027-03-08');
		expect(painted.state.target).toBe('soonestArrival');
	});

	it('stores a cut placed on the span end as blank, so it keeps following the span', () => {
		const painted = paintDay(MARCH, armTarget('latestDeparture'), '2027-03-20');
		expect(painted.fields.latestDepartureOverride).toBe('');
		const arrival = paintDay(MARCH, armTarget('soonestArrival'), '2027-03-06');
		expect(arrival.fields.soonestArrivalOverride).toBe('');
	});

	it('clears a cut when the same day is tapped again', () => {
		const set = paintDay(MARCH, armTarget('latestDeparture'), '2027-03-08');
		const cleared = paintDay(set.fields, armTarget('latestDeparture'), '2027-03-08');
		expect(cleared.fields.latestDepartureOverride).toBe('');
	});

	it('drops a cut that the redrawn span no longer contains', () => {
		const narrowed = { ...MARCH, latestDepartureOverride: '2027-03-08', soonestArrivalOverride: '2027-03-18' };
		const first = paintDay(narrowed, INITIAL_PAINT, '2027-06-01');
		const second = paintDay(first.fields, first.state, '2027-06-10');
		expect(second.fields.latestDepartureOverride).toBe('');
		expect(second.fields.soonestArrivalOverride).toBe('');
	});

	it('keeps a cut the redrawn span still contains', () => {
		const narrowed = { ...MARCH, latestDepartureOverride: '2027-03-08' };
		const first = paintDay(narrowed, INITIAL_PAINT, '2027-03-01');
		const second = paintDay(first.fields, first.state, '2027-03-31');
		expect(second.fields.latestDepartureOverride).toBe('2027-03-08');
	});

	it('never mutates what it was given', () => {
		const before = { ...MARCH };
		paintDay(MARCH, INITIAL_PAINT, '2027-05-05');
		expect(MARCH).toEqual(before);
	});
});

describe('armTarget', () => {
	it('abandons a half-drawn span rather than completing it against a later tap', () => {
		const half = paintDay(fields(), INITIAL_PAINT, '2027-03-06');
		expect(armTarget('latestDeparture')).toEqual({ target: 'latestDeparture', anchor: undefined });
		expect(half.state.anchor).toBe('2027-03-06');
	});
});

describe('previewWindows', () => {
	it('paints the range the next tap would produce while a span is half drawn', () => {
		const half = paintDay(fields(), INITIAL_PAINT, '2027-03-06');
		expect(previewWindows(half.fields, half.state, '2027-03-11')).toMatchObject({
			departFrom: '2027-03-06',
			arriveTo: '2027-03-11'
		});
	});

	it('previews backwards from the anchor too', () => {
		const half = paintDay(fields(), INITIAL_PAINT, '2027-03-11');
		expect(previewWindows(half.fields, half.state, '2027-03-06')).toMatchObject({
			departFrom: '2027-03-06',
			arriveTo: '2027-03-11'
		});
	});

	it('shows the real windows when nothing is pending', () => {
		expect(previewWindows(MARCH, INITIAL_PAINT, '2027-03-11')).toEqual(resolveWindows(MARCH));
	});
});

describe('rangeLabel', () => {
	it('says one date once', () => {
		expect(rangeLabel('2027-03-06', '2027-03-06')).toBe('6 Mar 2027');
	});

	it('says the month and year once when both ends share them', () => {
		expect(rangeLabel('2027-03-06', '2027-03-20')).toBe('6 to 20 Mar 2027');
	});

	it('repeats the month across a month boundary', () => {
		expect(rangeLabel('2027-02-28', '2027-03-03')).toBe('28 Feb to 3 Mar 2027');
	});

	it('spells both years out across a year boundary', () => {
		expect(rangeLabel('2027-12-28', '2028-01-03')).toBe('28 Dec 2027 to 3 Jan 2028');
	});

	it('has something to say before anything is picked', () => {
		expect(rangeLabel('', '')).toBe('Not set');
	});
});

describe('spanLength', () => {
	it('counts both ends', () => {
		expect(spanLength('2027-03-06', '2027-03-20')).toBe('15 days');
		expect(spanLength('2027-03-06', '2027-03-06')).toBe('1 day');
	});

	it('says nothing about a span that is not there or is backwards', () => {
		expect(spanLength('', '2027-03-20')).toBe('');
		expect(spanLength('2027-03-20', '2027-03-06')).toBe('');
	});
});

describe('visibleMonths', () => {
	it('opens on a year from this month', () => {
		const months = visibleMonths('2027-03-06', fields());
		expect(months[0]).toBe('2027-03-01');
		expect(months.at(-1)).toBe('2028-03-01');
	});

	it('stretches to hold dates a shared link arrived with', () => {
		const months = visibleMonths('2027-03-06', fields({ soonestDeparture: '2027-01-04', latestArrival: '2029-01-04' }));
		expect(months[0]).toBe('2027-01-01');
		expect(months.at(-1)).toBe('2029-01-01');
	});
});
