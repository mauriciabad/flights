import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AIRPORT_WAITING_TIME_MINUTES,
	DEFAULT_LANDING_TO_TRANSPORT_TIME_MINUTES,
	DEFAULT_WAITING_TIME_RULES
} from '$lib/domain/waiting-time';

// Guards the two numbers the brief calls out by name (line 39: "2h" default airport
// waiting time, "3h" for a long flight or a large airport) against a future edit that
// changes them without meaning to. Also doubles as the Vitest + `$lib` alias smoke
// test for this harness — see tests/e2e/README.md for where E2E tests live instead.
describe('waiting-time defaults', () => {
	it('defaults the flat airport waiting time to 2 hours', () => {
		expect(DEFAULT_AIRPORT_WAITING_TIME_MINUTES).toBe(120);
	});

	it('defaults landing-to-transport time to 15 minutes', () => {
		expect(DEFAULT_LANDING_TO_TRANSPORT_TIME_MINUTES).toBe(15);
	});

	it('bumps a long flight at a large airport to 3 hours', () => {
		const largeLongRule = DEFAULT_WAITING_TIME_RULES.find(
			(rule) => rule.airportSize === 'large' && rule.flightLength === 'long'
		);
		expect(largeLongRule?.waitingTime).toBe(180);
	});
});
