import type { AirportSizeClass, Duration, FlightLengthClass, LandingToTransportRule, WaitingTimeRule } from '$lib/domain';

/**
 * The normalised shape `TieredDurationField` edits, shared by both of the brief's
 * tiered controls (line 39): airport waiting time (which varies by airport size *and*
 * flight length) and landing-to-transport time (airport size only). Rather than the
 * field component knowing about `WaitingTimeRule` vs `LandingToTransportRule` and their
 * differently-named duration field (`waitingTime` vs `time`), both convert to/from this
 * one row shape at the edges, so the editing UI itself is written once.
 *
 * `id` exists only to give `{#each}` a stable key while a row's own matchers are being
 * edited (two rows can transiently share the same `airportSize`/`flightLength` while the
 * user is mid-edit, so the matchers themselves aren't a safe key).
 */
export interface TieredRuleRow {
	id: number;
	airportSize?: AirportSizeClass;
	flightLength?: FlightLengthClass;
	minutes: number;
}

let nextRowId = 0;

export function createRow(partial: Partial<Omit<TieredRuleRow, 'id'>> = {}): TieredRuleRow {
	return { id: nextRowId++, minutes: 0, ...partial };
}

export function waitingTimeRulesToRows(rules: WaitingTimeRule[]): TieredRuleRow[] {
	return rules.map((rule) =>
		createRow({ airportSize: rule.airportSize, flightLength: rule.flightLength, minutes: rule.waitingTime })
	);
}

export function rowsToWaitingTimeRules(rows: TieredRuleRow[]): WaitingTimeRule[] {
	return rows.map((row) => {
		const rule: WaitingTimeRule = { waitingTime: row.minutes as Duration };
		if (row.airportSize) rule.airportSize = row.airportSize;
		if (row.flightLength) rule.flightLength = row.flightLength;
		return rule;
	});
}

export function landingToTransportRulesToRows(rules: LandingToTransportRule[]): TieredRuleRow[] {
	return rules.map((rule) => createRow({ airportSize: rule.airportSize, minutes: rule.time }));
}

export function rowsToLandingToTransportRules(rows: TieredRuleRow[]): LandingToTransportRule[] {
	return rows.map((row) => {
		const rule: LandingToTransportRule = { time: row.minutes as Duration };
		if (row.airportSize) rule.airportSize = row.airportSize;
		return rule;
	});
}
