import { describe, expect, it } from 'vitest';
import {
	chooseTerminal,
	haversineKm,
	isPassengerTerminal,
	MAX_TERMINAL_DISTANCE_KM,
	MIN_SHIFT_KM,
	roundCoordinate
} from './terminal-match.mjs';

/** London Gatwick as OurAirports publishes it: the runway reference point, out on the
 * airfield, which is the coordinate issue #341 is about. */
const GATWICK = { latitude: 51.148744, longitude: -0.185739 };

/** The three `aeroway=terminal` elements Overpass returns inside Gatwick's box, with the
 * tags they actually carry on 2026-09-05. Two passenger halls and a freight shed. */
const GATWICK_TERMINALS = [
	{
		id: 'relation/2300449',
		name: 'North Terminal',
		building: 'airport_terminal',
		latitude: 51.1596161,
		longitude: -0.1753225
	},
	{
		id: 'relation/1774182',
		name: 'South Terminal',
		building: 'airport_terminal',
		latitude: 51.1562808,
		longitude: -0.1664222
	},
	{
		id: 'way/20052276',
		name: 'Cargo Terminal',
		building: 'hangar',
		latitude: 51.1576063,
		longitude: -0.1860434
	}
];

describe('which OSM building is a passenger terminal', () => {
	it('keeps the halls and drops the freight shed', () => {
		const kept = GATWICK_TERMINALS.filter(isPassengerTerminal).map((t) => t.name);
		expect(kept).toEqual(['North Terminal', 'South Terminal']);
	});

	it('drops a private jet centre that is closer than the passenger hall', () => {
		// Stansted. `Harrods Aviation` is 640m from the runway point and would win on
		// distance, and no scheduled passenger has ever walked out of it.
		expect(isPassengerTerminal({ name: 'Harrods Aviation', building: 'yes' })).toBe(false);
		expect(isPassengerTerminal({ name: 'General Aviation Center', building: 'yes' })).toBe(false);
	});

	it('drops cargo under the name it carries locally, not only in English', () => {
		for (const name of ['Cargo Terminal', 'Frachtzentrum', 'Terminal de Carga', 'Gare de Fret']) {
			expect(isPassengerTerminal({ name, building: 'yes' })).toBe(false);
		}
	});

	it('keeps a terminal with no name at all', () => {
		// Common outside Europe, and an unnamed building tagged aeroway=terminal is still
		// the terminal. Dropping it would leave those airports on the runway point.
		expect(isPassengerTerminal({ building: 'yes' })).toBe(true);
	});
});

describe('choosing an airport a terminal', () => {
	it('answers the nearest passenger hall to the published point', () => {
		const chosen = chooseTerminal(GATWICK, GATWICK_TERMINALS.filter(isPassengerTerminal));
		expect(chosen?.terminal.name).toBe('North Terminal');
		// The number this whole table exists for: Gatwick's published coordinate is a mile
		// and a half from the building the traveller walks out of.
		expect(chosen?.km).toBeCloseTo(1.41, 1);
	});

	it('answers nothing when the terminal is already where the airport says it is', () => {
		// Heathrow: 70m between the two, so the row would change no routed answer and
		// shipping it would only cost bytes.
		const heathrow = { latitude: 51.4706, longitude: -0.461941 };
		expect(
			chooseTerminal(heathrow, [
				{ id: 'relation/18911624', name: 'Terminal 3', latitude: 51.47104, longitude: -0.46075 }
			])
		).toBeNull();
	});

	it('answers nothing when every terminal is further off than the radius', () => {
		const far = { latitude: 51.148744, longitude: -0.185739 };
		expect(
			chooseTerminal(far, [{ id: 'way/1', name: 'Elsewhere', latitude: 51.4, longitude: -0.4 }])
		).toBeNull();
	});

	it('answers nothing when the airport has no terminal mapped', () => {
		expect(chooseTerminal(GATWICK, [])).toBeNull();
	});
});

describe('the numbers the rule is stated in', () => {
	it('rounds to about eleven metres', () => {
		expect(roundCoordinate(51.15961612345)).toBe(51.1596);
	});

	it('measures the Gatwick pair the issue measured', () => {
		expect(haversineKm(GATWICK, GATWICK_TERMINALS[0])).toBeCloseTo(1.41, 1);
	});

	it('holds a radius wider than the shift it screens for', () => {
		// Stated as a test because the two constants are only meaningful together: a
		// shift floor above the radius would accept nothing at all.
		expect(MIN_SHIFT_KM).toBeLessThan(MAX_TERMINAL_DISTANCE_KM);
	});
});
