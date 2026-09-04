import { describe, expect, it } from 'vitest';
import type { Duration } from '$lib/domain/duration';
import { createDefaultFormFields, type SearchFormFields } from './model';
import { fieldsToSearchParams, searchParamsToFields } from './url-codec';

function filledFields(): SearchFormFields {
	const fields = createDefaultFormFields();
	fields.soonestDeparture = '2026-10-01';
	fields.latestArrival = '2026-10-10';
	fields.latestDepartureOverride = '2026-10-05';
	fields.soonestArrivalOverride = '2026-09-28';
	fields.originAirport = 'BCN';
	fields.destinationAirport = 'VIE';
	fields.originLocation = {
		label: 'Barcelona city centre',
		coordinates: { latitude: 41.3851, longitude: 2.1734 }
	};
	fields.destinationLocation = {
		label: 'Vienna, Stephansplatz',
		coordinates: { latitude: 48.2082, longitude: 16.3738 }
	};
	fields.travellers = 2;
	fields.females = 1;
	fields.forbiddenConnectionCountries = ['RU', 'BY'];
	fields.forbiddenConnectionAirports = ['LHR'];
	fields.airlinesToAvoid = ['FR'];
	fields.minLayoverTime = 45;
	fields.allowedConnectionAirports = ['MUC'];
	fields.waitingTimeRules = [
		{ waitingTime: 90 as Duration },
		{ airportSize: 'large', flightLength: 'long', waitingTime: 200 as Duration }
	];
	fields.landingToTransportRules = [
		{ time: 20 as Duration },
		{ airportSize: 'large', time: 40 as Duration }
	];
	return fields;
}

describe('search form URL codec', () => {
	it('round-trips a fully populated form', () => {
		const fields = filledFields();
		const roundTripped = searchParamsToFields(fieldsToSearchParams(fields));
		expect(roundTripped).toEqual(fields);
	});

	it('an empty form round-trips to the same blank defaults', () => {
		expect(searchParamsToFields(new URLSearchParams())).toEqual(createDefaultFormFields());
	});

	it('never freezes the derived cross-field defaults into the URL when the user left them blank', () => {
		const fields = createDefaultFormFields();
		fields.soonestDeparture = '2026-10-01';
		fields.latestArrival = '2026-10-10';
		fields.originAirport = 'BCN';
		fields.destinationAirport = 'VIE';
		// latestDepartureOverride / soonestArrivalOverride left blank on purpose.

		const params = fieldsToSearchParams(fields);
		expect(params.has('depLatest')).toBe(false);
		expect(params.has('arrSoonest')).toBe(false);

		// And reloading them still resolves to the (live) derived value, not an empty one.
		const reloaded = searchParamsToFields(params);
		expect(reloaded.latestDepartureOverride).toBe('');
		expect(reloaded.soonestArrivalOverride).toBe('');
	});

	it('produces a readable, compact format for the tiered rules rather than URL-encoded JSON', () => {
		const fields = filledFields();
		const params = fieldsToSearchParams(fields);
		expect(params.get('wait')).toBe('*:*:90,large:long:200');
		expect(params.get('transport')).toBe('*:20,large:40');
	});

	it('ignores a malformed rule segment instead of throwing', () => {
		const params = new URLSearchParams({
			dep: '2026-10-01',
			arr: '2026-10-10',
			from: 'BCN',
			to: 'VIE',
			wait: 'not-a-rule,large:long:180'
		});
		expect(() => searchParamsToFields(params)).not.toThrow();
		const fields = searchParamsToFields(params);
		expect(fields.waitingTimeRules).toEqual([{ airportSize: 'large', flightLength: 'long', waitingTime: 180 }]);
	});

	it('ignores a malformed location segment instead of throwing', () => {
		const params = new URLSearchParams({
			dep: '2026-10-01',
			arr: '2026-10-10',
			from: 'BCN',
			to: 'VIE',
			fromLoc: 'not-a-location'
		});
		expect(() => searchParamsToFields(params)).not.toThrow();
		expect(searchParamsToFields(params).originLocation).toBeUndefined();
	});

	it('lower-cased airport codes in the URL still come back upper-cased', () => {
		const params = new URLSearchParams({ dep: '2026-10-01', arr: '2026-10-10', from: 'bcn', to: 'vie' });
		const fields = searchParamsToFields(params);
		expect(fields.originAirport).toBe('BCN');
		expect(fields.destinationAirport).toBe('VIE');
	});
});
