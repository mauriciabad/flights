import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AIRPORT_WAITING_TIME_MINUTES,
	DEFAULT_LANDING_TO_TRANSPORT_TIME_MINUTES,
	DEFAULT_WAITING_TIME_RULES
} from '$lib/domain/waiting-time';

// Guards the shipped default against a future edit that changes it without meaning to.
// The brief named two numbers on line 39, 2h flat and 3h for a long flight at a large
// airport, and the owner has since overruled the second: "i want 2h always by default".
// Also doubles as the Vitest + `$lib` alias smoke test for this harness — see
// tests/e2e/README.md for where E2E tests live instead.
describe('waiting-time defaults', () => {
	it('defaults the flat airport waiting time to 2 hours', () => {
		expect(DEFAULT_AIRPORT_WAITING_TIME_MINUTES).toBe(120);
	});

	it('defaults landing-to-transport time to 15 minutes', () => {
		expect(DEFAULT_LANDING_TO_TRANSPORT_TIME_MINUTES).toBe(15);
	});

	it('ships one flat rule, with no tier for a long flight at a large airport', () => {
		expect(DEFAULT_WAITING_TIME_RULES).toEqual([{ waitingTime: 120 }]);
		expect(
			DEFAULT_WAITING_TIME_RULES.some((rule) => rule.airportSize || rule.flightLength)
		).toBe(false);
	});
});
