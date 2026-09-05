import { describe, expect, it } from 'vitest';
import {
	costIsUnknown,
	groundFare,
	maxPlausibleRoadMinutes,
	ROAD_FIXED_ALLOWANCE_MINUTES,
	SLOWEST_USEFUL_ROAD_KM_PER_HOUR
} from './transfer';
import type { Transfer, TransferMode } from './transfer';
import type { Duration } from './duration';
import type { FareEstimate } from './fare';

/**
 * The fourteen routes `SLOWEST_USEFUL_ROAD_KM_PER_HOUR`'s own comment tabulates, measured
 * against `routing.openstreetmap.de/routed-car` on 2026-09-05. They are here rather than
 * only in prose so that moving the constant has to face them: raise it to 15 and Split to
 * Hvar fails, drop it to 4 and Athens to Santorini does.
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

		expect(tightest(true)).toBeGreaterThan(1.25);
		expect(tightest(false)).toBeGreaterThan(1.25);
		expect(tightest(true)).toBeGreaterThan(tightest(false));
	});

	it('never refuses a road transfer of an hour or less, at any distance', () => {
		// The property ROAD_FIXED_ALLOWANCE_MINUTES exists for, stated so a reader can check
		// it without arithmetic. A bed a kilometre away across an unbridged river is a real
		// 20 km detour whose crow-flight pace reads as nonsense, and this is what keeps it.
		for (const km of [0, 0.4, 0.95, 3, 12.3]) {
			expect(maxPlausibleRoadMinutes(km)).toBeGreaterThanOrEqual(60);
		}
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

function transfer(mode: TransferMode, extra: Partial<Transfer> = {}): Transfer {
	return { mode, duration: 20 as Duration, legs: [{ mode, duration: 20 as Duration }], ...extra };
}

const RANGE: FareEstimate = {
	kind: 'estimate',
	currency: 'GBP',
	lowMinorUnits: 2426,
	highMinorUnits: 3830,
	countryCode: 'GB',
	rateSource: 'country',
	citation: 'London black-cab Tariff 1'
};

const REFUSAL: FareEstimate = {
	kind: 'out-of-range',
	distanceKm: 94.9,
	ratedUpToKm: 30,
	countryCode: 'GB',
	citation: 'London black-cab Tariff 1'
};

describe('groundFare', () => {
	it('reads a walk as free rather than as a fare nobody gave', () => {
		expect(groundFare(transfer('walk'))).toEqual({ kind: 'free' });
	});

	it('reads a quoted fare as quoted whatever the mode', () => {
		const price = { minorUnits: 450, currency: 'EUR' as const };
		expect(groundFare(transfer('transit', { price }))).toEqual({ kind: 'quoted', price });
	});

	it('prefers a real quote over an estimate for the same leg', () => {
		// Nothing produces both today. If a provider ever starts quoting the leg this app is
		// guessing at, the quote is the answer and the guess must not shadow it.
		const price = { minorUnits: 3000, currency: 'GBP' as const };
		expect(groundFare(transfer('taxi', { price, fareEstimate: RANGE }))).toEqual({
			kind: 'quoted',
			price
		});
	});

	it('reads a rate-card range as an estimate, carrying the range itself', () => {
		expect(groundFare(transfer('taxi', { fareEstimate: RANGE }))).toEqual({
			kind: 'estimated',
			estimate: RANGE
		});
	});

	it('keeps issue #246 refusal distinct from having asked nobody', () => {
		expect(groundFare(transfer('taxi', { fareEstimate: REFUSAL }))).toEqual({
			kind: 'beyond-rate-card',
			refusal: REFUSAL
		});
		expect(groundFare(transfer('taxi'))).toEqual({ kind: 'unquoted' });
	});

	it('never estimates a bus, because Transitous quotes no fares at all', () => {
		expect(groundFare(transfer('transit'))).toEqual({ kind: 'unquoted' });
	});
});

describe('costIsUnknown', () => {
	it('still counts an estimated leg as unknown, which is what keeps the guess out of the total', () => {
		// The load-bearing assertion of issue #249. `algorithm/build.ts` sums only quoted
		// money and `algorithm/score.ts` charges its own assumption for every leg this
		// predicate flags, so flipping an estimated leg to "known" would put a rate-card
		// guess inside `Itinerary.totalPrice`, and from there inside the max-price filter
		// and the cheapest-first sort.
		expect(costIsUnknown(transfer('taxi', { fareEstimate: RANGE }))).toBe(true);
		expect(costIsUnknown(transfer('taxi', { fareEstimate: REFUSAL }))).toBe(true);
		expect(costIsUnknown(transfer('taxi'))).toBe(true);
	});

	it('leaves a walk and a quoted ride known, as issue #204 set them', () => {
		expect(costIsUnknown(transfer('walk'))).toBe(false);
		expect(
			costIsUnknown(transfer('transit', { price: { minorUnits: 450, currency: 'EUR' } }))
		).toBe(false);
	});
});
