import { describe, expect, it } from 'vitest';
import { greatCircleDistanceKm, groundTransferPoint } from '$lib/domain';
import { getAirport, loadAirports } from './airports';
import { loadAirportTerminals, parseAirportTerminals } from './airport-terminals';

/** The two numbers from `scripts/terminal-match.mjs`, repeated so a change to either has
 * to come past this file. */
const MAX_TERMINAL_DISTANCE_KM = 6;
const MIN_SHIFT_KM = 0.25;

describe('reading the generated table', () => {
	it('drops a row that is not two finite numbers rather than passing NaN on', () => {
		const parsed = parseAirportTerminals({
			LGW: [51.1596, -0.1753],
			BAD: [Number.NaN, 2],
			SHORT: [1],
			EMPTY: []
		});
		expect([...parsed.keys()]).toEqual(['LGW']);
	});

	it('has a row for every airport the shipped file names, and only valid ones', async () => {
		const terminals = await loadAirportTerminals();
		expect(terminals.size).toBeGreaterThan(3000);
		for (const [, point] of terminals) {
			expect(Math.abs(point.latitude)).toBeLessThanOrEqual(90);
			expect(Math.abs(point.longitude)).toBeLessThanOrEqual(180);
		}
	});
});

describe('the terminal every row points at', () => {
	it('belongs to the airport it is filed under, and moves it enough to matter', async () => {
		// The rule in `scripts/terminal-match.mjs`, checked against all 3,000-odd shipped
		// rows rather than the handful the script printed. A row outside the radius would
		// be a building stolen from a neighbouring field; one inside the floor would be a
		// row that changes no answer and costs bytes on a phone.
		const airports = await loadAirports();
		const terminals = await loadAirportTerminals();
		const offenders: string[] = [];
		for (const airport of airports) {
			const terminal = terminals.get(airport.iataCode);
			if (!terminal) continue;
			const km = greatCircleDistanceKm(airport.coordinates, terminal);
			if (km < MIN_SHIFT_KM || km > MAX_TERMINAL_DISTANCE_KM) {
				offenders.push(`${airport.iataCode} ${km.toFixed(2)}km`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('names no airport this dataset has never heard of', async () => {
		const airports = await loadAirports();
		const codes = new Set(airports.map((airport) => airport.iataCode));
		const terminals = await loadAirportTerminals();
		expect([...terminals.keys()].filter((code) => !codes.has(code))).toEqual([]);
	});
});

describe('where a ground transfer touches an airport', () => {
	it('starts a Gatwick transfer at the North Terminal, not on the airfield', async () => {
		// The issue's own airport. OurAirports publishes LGW at 51.1487, -0.1857, which is
		// out on the movement area with the runway between it and both terminals, and
		// `routing.openstreetmap.de/routed-foot` will not cross a runway. Measured on
		// 2026-09-05: from the published point the walk to The Gatwick White House Hotel is
		// 5.46 km and 1h 13m, and the 45-minute cap threw it away; from this coordinate it
		// is 2.42 km and 32m, and the traveller is finally offered it.
		const gatwick = await getAirport('LGW');
		expect(gatwick?.coordinates).toEqual({ latitude: 51.148744, longitude: -0.185739 });
		expect(gatwick?.terminalCoordinates).toEqual({ latitude: 51.1596, longitude: -0.1753 });
		expect(gatwick && groundTransferPoint(gatwick)).toEqual(gatwick?.terminalCoordinates);
		expect(greatCircleDistanceKm(gatwick!.coordinates, gatwick!.terminalCoordinates!)).toBeCloseTo(
			1.41,
			1
		);
	});

	it('leaves an airport whose terminal is already at its published point alone', async () => {
		// Heathrow's two points are 70 m apart, so no row was generated and nothing changes.
		// This is the case that must keep working untouched, since it is three quarters of
		// the dataset by the same test.
		const heathrow = await getAirport('LHR');
		expect(heathrow?.terminalCoordinates).toBeUndefined();
		expect(heathrow && groundTransferPoint(heathrow)).toEqual(heathrow?.coordinates);
	});
});
