import { describe, expect, it } from 'vitest';
import {
	maxPlausibleRoadMinutes,
	ROAD_FIXED_ALLOWANCE_MINUTES,
	SLOWEST_USEFUL_ROAD_KM_PER_HOUR
} from './transfer';

/**
 * The fourteen routes `SLOWEST_USEFUL_ROAD_KM_PER_HOUR`'s own comment tabulates, measured
 * against `routing.openstreetmap.de/routed-car` on 2026-09-05. They are here rather than
 * only in prose so that moving the constant has to face them: change 7 to 15 and Split to
 * Vis fails, change it to 4 and Athens to Santorini does.
 *
 * `keep` is the claim, not the observation. Every one of these routes is a real answer the
 * router gave; the flag says whether a traveller should be offered it.
 */
const MEASURED_ROUTES: { name: string; straightKm: number; minutes: number; keep: boolean }[] = [
	{ name: 'Inverness airport to Portree, Skye', straightKm: 129.2, minutes: 164, keep: true },
	{ name: 'Barcelona airport to Placa de Catalunya', straightKm: 12.3, minutes: 17, keep: true },
	{ name: 'Helsinki airport to Tallinn old town', straightKm: 98.6, minutes: 158, keep: true },
	{ name: 'Alesund airport to Geiranger', straightKm: 76.0, minutes: 138, keep: true },
	{ name: 'Gatwick to Kings Cross', straightKm: 42.1, minutes: 78, keep: true },
	{ name: 'Naples airport to Capri town', straightKm: 37.3, minutes: 72, keep: true },
	{ name: 'Bergen airport to Balestrand', straightKm: 123.6, minutes: 241, keep: true },
	{ name: 'Marseille airport to Ajaccio, Corsica', straightKm: 333.5, minutes: 743, keep: true },
	{ name: 'Athens airport to Aegina town', straightKm: 50.0, minutes: 117, keep: true },
	{ name: 'Vancouver airport to Victoria BC', straightKm: 86.5, minutes: 238, keep: true },
	{ name: 'Split airport to Vis town', straightKm: 53.9, minutes: 210, keep: true },
	{ name: 'Split airport to Hvar town', straightKm: 42.3, minutes: 284, keep: true },
	{ name: 'Athens airport to Thira, Santorini', straightKm: 214.4, minutes: 2251, keep: false },
	{ name: 'Athens airport to Naxos town', straightKm: 156.6, minutes: 1980, keep: false }
];

describe('maxPlausibleRoadMinutes', () => {
	it.each(MEASURED_ROUTES)('$name', ({ straightKm, minutes, keep }) => {
		expect(minutes <= maxPlausibleRoadMinutes(straightKm)).toBe(keep);
	});

	it('clears every measured route by a fifth, and clears the real ones by more', () => {
		// A number wedged between two neighbours with no room is a number that will be wrong
		// the first time somebody measures a fifteenth route, so the margins are asserted and
		// not merely which side of the line each route falls.
		//
		// The two margins are not equal and are not meant to be. Deleting a journey somebody
		// would really take is the worse mistake, so where the evidence runs out it runs out
		// on the loose side — the same direction osrm.ts's FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR
		// and #220's SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR both err in.
		const margins = MEASURED_ROUTES.map(({ straightKm, minutes, keep }) => {
			const bound = maxPlausibleRoadMinutes(straightKm);
			return { keep, margin: keep ? bound / minutes : minutes / bound };
		});
		const tightest = (keep: boolean) =>
			Math.min(...margins.filter((m) => m.keep === keep).map((m) => m.margin));

		expect(tightest(true)).toBeGreaterThan(1.2);
		expect(tightest(false)).toBeGreaterThan(1.2);
		expect(tightest(true)).toBeGreaterThan(tightest(false));
	});

	it('cannot refuse a short hop, whatever the router says about it', () => {
		// A bed 800 m away on the far side of an airport perimeter road is a real four
		// kilometres of tarmac, and its straight-line pace is nonsense however fast the car
		// goes. ROAD_FIXED_ALLOWANCE_MINUTES is what stops the rule reading that as an
		// artefact.
		expect(maxPlausibleRoadMinutes(0.8)).toBeGreaterThan(30);
		expect(maxPlausibleRoadMinutes(0)).toBe(ROAD_FIXED_ALLOWANCE_MINUTES);
	});

	it('is monotonic, so a farther bed is never held to a tighter bound', () => {
		let previous = 0;
		for (const km of [0, 1, 5, 12.3, 50, 100, 333.5, 1000]) {
			const bound = maxPlausibleRoadMinutes(km);
			expect(bound).toBeGreaterThan(previous);
			previous = bound;
		}
	});

	it('treats a negative distance as zero rather than inverting the bound', () => {
		expect(maxPlausibleRoadMinutes(-40)).toBe(ROAD_FIXED_ALLOWANCE_MINUTES);
	});

	it('stays above walking pace, which is the argument for the number', () => {
		// osrm.ts puts the fastest any pedestrian router could claim at 6 km/h. A floor at or
		// below that would mean refusing only routes a walker beats, which is not a bound on
		// transport, it is a bound on arithmetic.
		expect(SLOWEST_USEFUL_ROAD_KM_PER_HOUR).toBeGreaterThan(6);
	});
});
