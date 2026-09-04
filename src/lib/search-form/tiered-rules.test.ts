import { describe, expect, it } from 'vitest';
import { DEFAULT_LANDING_TO_TRANSPORT_RULES, DEFAULT_WAITING_TIME_RULES } from '$lib/domain/waiting-time';
import {
	landingToTransportRulesToRows,
	rowsToLandingToTransportRules,
	rowsToWaitingTimeRules,
	waitingTimeRulesToRows
} from './tiered-rules';

describe('waiting-time row conversion', () => {
	it('round-trips the documented default rules', () => {
		const rows = waitingTimeRulesToRows(DEFAULT_WAITING_TIME_RULES);
		expect(rowsToWaitingTimeRules(rows)).toEqual(DEFAULT_WAITING_TIME_RULES);
	});

	it('drops an unset matcher rather than writing it as undefined-but-present', () => {
		const rows = waitingTimeRulesToRows(DEFAULT_WAITING_TIME_RULES);
		expect(Object.hasOwn(rowsToWaitingTimeRules(rows)[0], 'airportSize')).toBe(false);
		expect(Object.hasOwn(rowsToWaitingTimeRules(rows)[0], 'flightLength')).toBe(false);
	});

	it('gives every row a distinct id even when matchers collide', () => {
		const rows = waitingTimeRulesToRows([DEFAULT_WAITING_TIME_RULES[0], DEFAULT_WAITING_TIME_RULES[0]]);
		expect(rows[0].id).not.toBe(rows[1].id);
	});
});

describe('landing-to-transport row conversion', () => {
	it('round-trips the documented default rules', () => {
		const rows = landingToTransportRulesToRows(DEFAULT_LANDING_TO_TRANSPORT_RULES);
		expect(rowsToLandingToTransportRules(rows)).toEqual(DEFAULT_LANDING_TO_TRANSPORT_RULES);
	});
});
