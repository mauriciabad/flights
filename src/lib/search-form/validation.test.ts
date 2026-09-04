import { describe, expect, it } from 'vitest';
import { createDefaultFormFields, type SearchFormFields } from './model';
import {
	FIELD_INPUT_ID,
	hasBlockingIssue,
	isCalendarDate,
	issuesByField,
	validateSearchFields
} from './validation';

const TODAY = '2026-09-04';

function validSearch(): SearchFormFields {
	const fields = createDefaultFormFields();
	fields.originAirport = 'BCN';
	fields.destinationAirport = 'OTP';
	fields.soonestDeparture = '2026-10-01';
	fields.latestArrival = '2026-10-20';
	return fields;
}

function messageFor(fields: SearchFormFields, field: keyof typeof FIELD_INPUT_ID) {
	return issuesByField(validateSearchFields(fields, { today: TODAY }))[field];
}

describe('validateSearchFields', () => {
	it('says nothing about a search that is fine', () => {
		expect(validateSearchFields(validSearch(), { today: TODAY })).toEqual([]);
	});

	it('names each missing required field rather than one lump error', () => {
		const issues = validateSearchFields(createDefaultFormFields(), { today: TODAY });
		expect(issues.map((issue) => issue.field)).toEqual([
			'originAirport',
			'destinationAirport',
			'soonestDeparture',
			'latestArrival'
		]);
		expect(issues.every((issue) => issue.severity === 'blocking')).toBe(true);
	});

	// The four cases the owner asked for by name.
	it('refuses an origin equal to the destination', () => {
		const fields = validSearch();
		fields.destinationAirport = 'BCN';
		expect(messageFor(fields, 'destinationAirport')).toBe(
			'BCN is also your origin. Pick somewhere else to fly to.'
		);
	});

	it('refuses an arrival before its own departure, and says which date to beat', () => {
		const fields = validSearch();
		fields.latestArrival = '2026-09-20';
		expect(messageFor(fields, 'latestArrival')).toBe(
			'You cannot arrive before you leave. Pick 2026-10-01 or later.'
		);
	});

	it('flags a departure in the past as advisory, not as an impossible trip', () => {
		const fields = validSearch();
		fields.soonestDeparture = '2026-08-01';
		const issues = validateSearchFields(fields, { today: TODAY });
		expect(issues).toEqual([
			{
				field: 'soonestDeparture',
				message: '2026-08-01 has already passed. Pick a later date.',
				severity: 'advisory'
			}
		]);
		expect(hasBlockingIssue(issues)).toBe(false);
	});

	it('refuses zero travellers', () => {
		const fields = validSearch();
		fields.travellers = 0;
		expect(messageFor(fields, 'travellers')).toBe('A trip needs at least one traveller.');
	});

	it('accepts today as a departure date', () => {
		const fields = validSearch();
		fields.soonestDeparture = TODAY;
		fields.latestArrival = TODAY;
		expect(validateSearchFields(fields, { today: TODAY })).toEqual([]);
	});

	it('rejects a number of travellers that is not whole', () => {
		const fields = validSearch();
		fields.travellers = 2.5;
		expect(messageFor(fields, 'travellers')).toBe('Enter a whole number of people.');
	});

	// The number inputs hand this module NaN for unparsable text rather than dropping it,
	// so "abc" travellers is an error the traveller sees instead of a silent default of 1.
	it('rejects travellers that could not be read as a number at all', () => {
		const fields = validSearch();
		fields.travellers = Number.NaN;
		expect(messageFor(fields, 'travellers')).toBe('Enter a whole number of people.');
	});

	it('refuses more female travellers than travellers', () => {
		const fields = validSearch();
		fields.travellers = 2;
		fields.females = 3;
		expect(messageFor(fields, 'females')).toBe(
			'You listed 3 female travellers in a party of 2. Raise the number of people, or lower this.'
		);
	});

	it('compares female travellers against the default party size when travellers is blank', () => {
		const fields = validSearch();
		fields.females = 2;
		expect(messageFor(fields, 'females')).toContain('in a party of 1');
	});

	it('refuses a negative minimum layover', () => {
		const fields = validSearch();
		fields.minLayoverTime = -10;
		expect(messageFor(fields, 'minLayoverTime')).toBe(
			'A layover cannot be shorter than no time at all.'
		);
	});

	it('rejects a date that looks like one but is not on the calendar', () => {
		const fields = validSearch();
		fields.soonestDeparture = '2026-02-31';
		expect(messageFor(fields, 'soonestDeparture')).toBe(
			'Write the date as YYYY-MM-DD, for example 2026-10-06.'
		);
	});

	it('rejects an airport code that is not three letters', () => {
		const fields = validSearch();
		fields.originAirport = 'Barcelona';
		expect(messageFor(fields, 'originAirport')).toBe(
			'An airport code is three letters, like BCN. "BARCELONA" is not one.'
		);
	});

	describe('date overrides', () => {
		it('refuses a latest departure earlier than the soonest one', () => {
			const fields = validSearch();
			fields.latestDepartureOverride = '2026-09-25';
			expect(messageFor(fields, 'latestDepartureOverride')).toBe(
				'The latest departure cannot be before the soonest one, 2026-10-01.'
			);
		});

		it('refuses a latest departure after the day you must have arrived', () => {
			const fields = validSearch();
			fields.latestDepartureOverride = '2026-10-25';
			expect(messageFor(fields, 'latestDepartureOverride')).toBe(
				'You would still be leaving after 2026-10-20, the day you need to have arrived.'
			);
		});

		it('refuses a soonest arrival before the soonest departure', () => {
			const fields = validSearch();
			fields.soonestArrivalOverride = '2026-09-28';
			expect(messageFor(fields, 'soonestArrivalOverride')).toBe(
				'You cannot arrive before you leave. Pick 2026-10-01 or later.'
			);
		});

		it('leaves a blank override alone', () => {
			const fields = validSearch();
			fields.latestDepartureOverride = '';
			fields.soonestArrivalOverride = '';
			expect(validateSearchFields(fields, { today: TODAY })).toEqual([]);
		});
	});

	describe('code lists', () => {
		it('catches a connection airport that is required and forbidden at once', () => {
			const fields = validSearch();
			fields.allowedConnectionAirports = ['VIE'];
			fields.forbiddenConnectionAirports = ['VIE'];
			expect(messageFor(fields, 'allowedConnectionAirports')).toBe(
				'VIE is on both lists, so nothing can match. Remove it from one of them.'
			);
		});

		it('catches an allowed connection that is one end of the trip', () => {
			const fields = validSearch();
			fields.allowedConnectionAirports = ['OTP'];
			expect(messageFor(fields, 'allowedConnectionAirports')).toBe(
				'OTP is already one end of this trip, so it cannot also be the stopover.'
			);
		});

		it('rejects a country code of the wrong length', () => {
			const fields = validSearch();
			fields.forbiddenConnectionCountries = ['RUS'];
			expect(messageFor(fields, 'forbiddenConnectionCountries')).toBe(
				'"RUS" is not a two-letter country code, like RU.'
			);
		});

		it('accepts an airline code with a digit in it', () => {
			const fields = validSearch();
			fields.airlinesToAvoid = ['U2', 'FR', 'W6'];
			expect(validateSearchFields(fields, { today: TODAY })).toEqual([]);
		});

		it('rejects an airline name typed where a code belongs', () => {
			const fields = validSearch();
			fields.airlinesToAvoid = ['RYANAIR'];
			expect(messageFor(fields, 'airlinesToAvoid')).toBe(
				'"RYANAIR" is not a two-character airline code, like FR or U2.'
			);
		});
	});
});

describe('isCalendarDate', () => {
	it.each([
		['2026-10-06', true],
		['2026-02-29', false],
		['2028-02-29', true],
		['2026-13-01', false],
		['2026-1-1', false],
		['tomorrow', false],
		['', false]
	])('%s is a calendar date: %s', (value, expected) => {
		expect(isCalendarDate(value)).toBe(expected);
	});
});

describe('issuesByField', () => {
	it('keeps the first message per field so a single input never shows two errors', () => {
		const map = issuesByField([
			{ field: 'travellers', message: 'first', severity: 'blocking' },
			{ field: 'travellers', message: 'second', severity: 'blocking' }
		]);
		expect(map.travellers).toBe('first');
	});
});
