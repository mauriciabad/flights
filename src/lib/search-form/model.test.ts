import { describe, expect, it } from 'vitest';
import type { Duration } from '$lib/domain/duration';
import { DEFAULT_MIN_LAYOVER_TIME_MINUTES, DEFAULT_TRAVELLERS } from '$lib/domain/search-query';
import { DEFAULT_LANDING_TO_TRANSPORT_RULES, DEFAULT_WAITING_TIME_RULES } from '$lib/domain/waiting-time';
import {
	buildSearchQuery,
	createDefaultFormFields,
	resolveLatestDeparture,
	resolveSoonestArrival
} from './model';

function requiredFieldsOnly() {
	const fields = createDefaultFormFields();
	fields.soonestDeparture = '2026-10-01';
	fields.latestArrival = '2026-10-10';
	fields.originAirport = 'bcn';
	fields.destinationAirport = 'vie';
	return fields;
}

describe('buildSearchQuery', () => {
	it('is null when a required field is missing', () => {
		expect(buildSearchQuery(createDefaultFormFields())).toBeNull();
	});

	it('is null when only some required fields are filled in', () => {
		const fields = createDefaultFormFields();
		fields.soonestDeparture = '2026-10-01';
		fields.originAirport = 'BCN';
		expect(buildSearchQuery(fields)).toBeNull();
	});

	// Issue #16 acceptance: "Leaving every optional field empty produces a valid
	// search" and "the documented defaults appear in the resulting SearchQuery."
	it('leaving every optional field empty yields a valid SearchQuery carrying the documented defaults', () => {
		const query = buildSearchQuery(requiredFieldsOnly());

		expect(query).toEqual({
			soonestDeparture: '2026-10-01',
			latestDeparture: '2026-10-10', // brief line 26: defaults to latest arrival
			latestArrival: '2026-10-10',
			soonestArrival: '2026-10-01', // brief line 28: defaults to soonest departure
			originAirport: 'BCN',
			destinationAirport: 'VIE',
			travellers: DEFAULT_TRAVELLERS,
			minLayoverTime: DEFAULT_MIN_LAYOVER_TIME_MINUTES,
			waitingTimeRules: DEFAULT_WAITING_TIME_RULES,
			landingToTransportRules: DEFAULT_LANDING_TO_TRANSPORT_RULES
		});
	});

	it('uppercases and trims airport codes', () => {
		const fields = requiredFieldsOnly();
		fields.originAirport = '  bcn ';
		fields.destinationAirport = 'vie';
		const query = buildSearchQuery(fields)!;
		expect(query.originAirport).toBe('BCN');
		expect(query.destinationAirport).toBe('VIE');
	});

	it('omits females, locations and the connection-restriction lists entirely when unset, since their brief default is absence, not a value', () => {
		const query = buildSearchQuery(requiredFieldsOnly())!;
		expect(query.females).toBeUndefined();
		expect(query.originLocation).toBeUndefined();
		expect(query.destinationLocation).toBeUndefined();
		expect(query.forbiddenConnectionCountries).toBeUndefined();
		expect(query.forbiddenConnectionAirports).toBeUndefined();
		expect(query.airlinesToAvoid).toBeUndefined();
		expect(query.allowedConnectionAirports).toBeUndefined();
	});

	it('keeps every explicit optional value the user provided', () => {
		const fields = requiredFieldsOnly();
		fields.travellers = 3;
		fields.females = 1;
		fields.minLayoverTime = 45;
		fields.forbiddenConnectionAirports = ['LHR'];
		fields.forbiddenConnectionCountries = ['RU'];
		fields.airlinesToAvoid = ['FR'];
		fields.allowedConnectionAirports = ['VIE', 'MUC'];
		fields.originLocation = {
			label: 'Barcelona city centre',
			coordinates: { latitude: 41.3851, longitude: 2.1734 }
		};

		const query = buildSearchQuery(fields)!;
		expect(query.travellers).toBe(3);
		expect(query.females).toBe(1);
		expect(query.minLayoverTime).toBe(45);
		expect(query.forbiddenConnectionAirports).toEqual(['LHR']);
		expect(query.forbiddenConnectionCountries).toEqual(['RU']);
		expect(query.airlinesToAvoid).toEqual(['FR']);
		expect(query.allowedConnectionAirports).toEqual(['VIE', 'MUC']);
		expect(query.originLocation?.label).toBe('Barcelona city centre');
	});

	it('a custom tiered waiting-time list overrides the default rather than merging with it', () => {
		const fields = requiredFieldsOnly();
		fields.waitingTimeRules = [{ waitingTime: 90 as Duration }];
		const query = buildSearchQuery(fields)!;
		expect(query.waitingTimeRules).toEqual([{ waitingTime: 90 }]);
	});
});

describe('resolveLatestDeparture / resolveSoonestArrival: derived, not copied', () => {
	it('follows the source field live until an explicit override is set', () => {
		const fields = requiredFieldsOnly();
		expect(resolveLatestDeparture(fields)).toBe('2026-10-10');

		// Editing the source field (latestArrival) moves the derived default with it -
		// nothing was copied into a separate stored field that could go stale.
		fields.latestArrival = '2026-11-01';
		expect(resolveLatestDeparture(fields)).toBe('2026-11-01');

		fields.latestDepartureOverride = '2026-10-15';
		expect(resolveLatestDeparture(fields)).toBe('2026-10-15');

		// Once overridden, further edits to the source field no longer reach through -
		// the override is now the real, independent value.
		fields.latestArrival = '2026-12-01';
		expect(resolveLatestDeparture(fields)).toBe('2026-10-15');
	});

	it('same derivation for soonestArrival from soonestDeparture', () => {
		const fields = requiredFieldsOnly();
		expect(resolveSoonestArrival(fields)).toBe('2026-10-01');

		fields.soonestDeparture = '2026-09-20';
		expect(resolveSoonestArrival(fields)).toBe('2026-09-20');

		fields.soonestArrivalOverride = '2026-09-25';
		expect(resolveSoonestArrival(fields)).toBe('2026-09-25');
	});
});
