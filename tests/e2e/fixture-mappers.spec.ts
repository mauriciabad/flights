import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/fixtures';
import { MemoryCacheStore } from '../../src/lib/cache';
import { greatCircleDistanceKm } from '../../src/lib/domain';
import type { Coordinates, TransitPlanMoment } from '../../src/lib/domain';
import { mapSearchResultToCandidate } from '../../src/lib/providers/stays/booking-mapper';
import {
	flattenGeoCities,
	mapPropertiesToStays
} from '../../src/lib/providers/stays/hostelworld-mapper';
import {
	mapOnePerCityResultToDestinations,
	mapOneWayResultToOffers
} from '../../src/lib/providers/flights/kiwi-public-mapper';
import { buildNetworkSnapshot } from '../../src/lib/providers/flights/ryanair-mapper';
import { mapSearchFlightsToOffers } from '../../src/lib/providers/flights/skyscanner-map-offers';
import { createOsrmTransferProvider, findTransfersToMany } from '../../src/lib/providers/transfers/osrm';
import { mapPlanResponseToTransfer } from '../../src/lib/providers/transfers/transitous-mapper';

/**
 * Issue #242. Every mock payload in tests/e2e/fixtures/ goes through the code that reads
 * the real response it stands in for, and has to come out the other side as something.
 *
 * The bug this exists to catch already happened. `transitous/plan.json` had no `duration`
 * on its only leg, `isValidLeg` is right to refuse that, so `mapPlanResponseToTransfer`
 * threw on every call, `transitous.ts` reported `malformed-response`, and both suites
 * spent their whole lives measuring that branch. Nothing noticed, because nothing had an
 * opinion about the transit path at all:
 *
 *   pnpm test:e2e, the broken fixture:  49 passed, 4 skipped
 *   pnpm test:e2e, the corrected one:   49 passed, 4 skipped
 *
 * Byte for byte identical. A fixture only has to be shaped like an answer if something
 * checks the answer, so this file checks every one of them, and `every fixture is
 * accounted for` below makes a new fixture opt in rather than slip past.
 *
 * `guard.spec.ts` is the sibling of this file and holds the other half of the bargain: a
 * fixture must never be worth anything as a real answer. This one says it must still be
 * worth something as a fake one.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(relativePath: string): unknown {
	return JSON.parse(readFileSync(path.join(fixturesDir, relativePath), 'utf-8'));
}

function findFixtures(dir: string, prefix = ''): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return findFixtures(path.join(dir, entry.name), relative);
		return entry.name.endsWith('.json') ? [relative] : [];
	});
}

/** Vienna airport, and the city 17 km away. Every stay and transfer fixture here is
 * placed around this pair, so the radius and plausibility filters the mappers apply have
 * a real geography to apply them to instead of an arbitrary one. */
const AIRPORT: Coordinates = { latitude: 48.1103, longitude: 16.5697 };
const CITY: Coordinates = { latitude: 48.185, longitude: 16.377 };

const AFTER_LANDING: TransitPlanMoment = {
	time: { local: '2027-03-08T09:20:00', timeZone: 'Europe/Vienna', utcOffsetMinutes: 60 },
	arriveBy: false
};

/** The other kind of question, and the other fixture. Issue #368: the ride back to the
 * airport is planned backwards from a check-in deadline, and the mapper picks the LAST
 * departure rather than the first when it is. */
const BEFORE_DEADLINE: TransitPlanMoment = {
	time: { local: '2027-03-10T09:00:00', timeZone: 'Europe/Vienna', utcOffsetMinutes: 60 },
	arriveBy: true
};

/**
 * The table service, which is a different endpoint and a different response shape from the
 * one `routeThroughOsrm` exercises. Issue #405: the stay list asks one origin against every
 * candidate property in a single request, and the answer is a matrix rather than a route.
 */
async function tableThroughOsrm(raw: unknown): Promise<number> {
	const result = await findTransfersToMany('drive', AIRPORT, [CITY], {
		signal: new AbortController().signal
	}, {
		store: new MemoryCacheStore(),
		fetchImpl: async () =>
			new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } })
	});
	if (!result.ok) throw new Error(`the OSRM adapter refused it: ${result.error.message}`);
	return result.data.filter(Boolean).length;
}

async function routeThroughOsrm(raw: unknown): Promise<number> {
	const provider = createOsrmTransferProvider({
		store: new MemoryCacheStore(),
		fetchImpl: async () =>
			new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } })
	});
	const result = await provider.searchTransfers(
		{ from: AIRPORT, to: CITY, modes: ['drive'] },
		{ signal: new AbortController().signal }
	);
	if (!result.ok) throw new Error(`the OSRM adapter refused it: ${result.error.message}`);
	return result.data.length;
}

interface FixtureCheck {
	/** What in `src/` reads a response of this shape. Named so a failure says where to look
	 * rather than only that something is wrong. */
	readBy: string;
	/**
	 * `'some'`: this fixture stands in for a provider that found something, so the mapper
	 * has to produce at least one domain object from it. `'none'`: the fixture is a
	 * deliberate empty answer — see support/providers.ts on why several defaults are empty
	 * — and the mapper has to accept it and produce nothing, without throwing.
	 */
	yields: 'some' | 'none';
	/** Runs the fixture through that code and returns how many domain objects came out.
	 * Throwing is a failure: a mapper that refuses a fixture is the whole defect. */
	map: (raw: unknown) => number | Promise<number>;
}

const CHECKS: Record<string, FixtureCheck> = {
	'booking/hotels-search.json': {
		readBy: 'providers/stays/booking-mapper.ts mapSearchResultToCandidate',
		yields: 'some',
		map: (raw) => {
			const results = (raw as { data?: { result?: unknown[] } }).data?.result ?? [];
			return results.filter((result) => mapSearchResultToCandidate(result as never)).length;
		}
	},
	'hostelworld/continents-empty.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts flattenGeoCities',
		yields: 'none',
		map: (raw) => flattenGeoCities(raw as never).length
	},
	'hostelworld/continents-vienna.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts flattenGeoCities',
		yields: 'some',
		map: (raw) => flattenGeoCities(raw as never).length
	},
	'hostelworld/properties-empty.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'none',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 25, 1).length
	},
	'hostelworld/properties-vienna.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 25, 1).length
	},
	// The same shape with a second property 32 km out, for `itinerary-editing.spec.ts`'s
	// bed swap (issues #243, #250). Read at the app's own 50 km radius rather than 25, so
	// this check fails if the far one ever stops mapping — that property being reachable is
	// the whole point of the fixture.
	'hostelworld/properties-vienna-walkable.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 25, 1).length
	},
	// Issue #367: two beds priced and placed so the ranking's answer genuinely moves between
	// one night and three, which is what `bed-pinning.spec.ts` needs in order to watch a
	// recommended bed change and a chosen one hold. Read at 50 km so the central one stays
	// reachable; the fixture proves nothing if the far bed drops out of the list.
	'hostelworld/properties-vienna-crossover.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 50, 1).length
	},
	// Issue #356: two beds far enough out that both get a taxi rather than a walk, which is
	// what makes the swapped one's missing fare visible beside the search's own. Read at 50 km
	// so both stay reachable; the fixture is pointless if either drops out.
	'hostelworld/properties-vienna-both-far.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 50, 1).length
	},
	'hostelworld/properties-vienna-two.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 50, 1).length
	},
	// The same shape carrying photographs, for issue #279's carousel. The image half of
	// `mapPropertiesToStays` had no fixture behind it at all before this: every stay fixture
	// here has `images: []`, so `imageUrls` joining a `{prefix, suffix}` pair into a URL was
	// covered by unit tests and by nothing that runs the real adapter. This check maps the
	// file and then asserts the URLs actually came out, because "the mapper accepted it" is
	// exactly the guarantee that hid issue #194.
	// Issue #288's property: one female dorm, one male dorm, no mixed one, and a
	// property-level `lowestAverageDormPricePerNight` all the same. Counted as restricted
	// stays rather than as stays, so this fails if the mapper ever goes back to selling
	// that unqualified figure as a mixed bed - which is the whole defect.
	'hostelworld/properties-vienna-restricted-dorms.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 25, 1).filter(
				(stay) => stay.roomKind === 'female-dorm' || stay.roomKind === 'male-dorm'
			).length
	},
	'hostelworld/properties-vienna-photos.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) => {
			const stays = mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 25, 1);
			const withPhotos = stays.filter((stay) => stay.property.images.length > 0);
			return withPhotos.length;
		}
	},
	// Six properties spread across Vienna, each with two photographs, for issue #319's stay
	// map and its price differences. Read at the app's own 50 km radius, and counted as
	// stays that carry a photograph rather than as stays, because both halves matter here:
	// a point on the map needs a property, and the sidebar needs a picture.
	'hostelworld/properties-vienna-many.json': {
		readBy: 'providers/stays/hostelworld-mapper.ts mapPropertiesToStays',
		yields: 'some',
		map: (raw) =>
			mapPropertiesToStays((raw as { properties?: never[] }).properties, AIRPORT, 50, 1).filter(
				(stay) => stay.property.images.length > 0
			).length
	},
	'kiwi-public/one-per-city-empty.json': {
		readBy: 'providers/flights/kiwi-public-mapper.ts mapOnePerCityResultToDestinations',
		yields: 'none',
		map: (raw) =>
			mapOnePerCityResultToDestinations(
				(raw as { data?: { onewayOnePerCityItineraries?: never } }).data
					?.onewayOnePerCityItineraries
			).length
	},
	'kiwi-public/one-way-empty.json': {
		readBy: 'providers/flights/kiwi-public-mapper.ts mapOneWayResultToOffers',
		yields: 'none',
		map: (raw) =>
			mapOneWayResultToOffers((raw as { data?: { onewayItineraries?: never } }).data?.onewayItineraries)
				.length
	},
	// Both OSRM fixtures go through the whole adapter rather than a mapping function,
	// because its response parsing lives inside `requestOsrm` and has no pure export. That
	// is fine here: a `fetchImpl` that always answers with the fixture and a
	// `MemoryCacheStore` exercise exactly the code path the mocked browser takes, with no
	// network and no timers.
	'osrm/route.json': {
		readBy: 'providers/transfers/osrm.ts searchTransfers',
		yields: 'some',
		map: (raw) => routeThroughOsrm(raw)
	},
	'osrm/table.json': {
		readBy: 'providers/transfers/osrm.ts findTransfersToMany',
		yields: 'some',
		map: (raw) => tableThroughOsrm(raw)
	},
	'osrm/route-long.json': {
		readBy: 'providers/transfers/osrm.ts searchTransfers',
		yields: 'some',
		map: (raw) => routeThroughOsrm(raw)
	},
	// The adapter accepts this one and issue #119's rule in `search/resources.ts` then
	// throws its answer away. Both facts have to hold for the spec that uses it to mean
	// anything: a fixture the adapter could not read would be refused for the wrong reason.
	'osrm/route-implausible.json': {
		readBy: 'providers/transfers/osrm.ts searchTransfers',
		yields: 'some',
		map: (raw) => routeThroughOsrm(raw)
	},
	'ryanair/active-airports.json': {
		readBy: 'providers/flights/ryanair-mapper.ts buildNetworkSnapshot',
		yields: 'some',
		map: (raw) => {
			const snapshot = buildNetworkSnapshot(raw as never, '2027-03-01T00:00:00.000Z');
			return Object.keys(snapshot.destinationsByOrigin).length;
		}
	},
	'skyscanner/search-flights.json': {
		readBy: 'providers/flights/skyscanner-map-offers.ts mapSearchFlightsToOffers',
		yields: 'some',
		map: (raw) =>
			mapSearchFlightsToOffers(raw, {
				currency: 'EUR',
				travellers: 1,
				timeZones: new Map([
					['STN', 'Europe/London'],
					['VIE', 'Europe/Vienna']
				])
			}).offers.length
	},
	'transitous/plan.json': {
		readBy: 'providers/transfers/transitous-mapper.ts mapPlanResponseToTransfer',
		yields: 'some',
		map: (raw) => {
			const transfer = mapPlanResponseToTransfer(
				raw as never,
				AFTER_LANDING,
				greatCircleDistanceKm(AIRPORT, CITY)
			);
			return transfer ? 1 : 0;
		}
	},
	'transitous/plan-arriveby.json': {
		readBy: 'providers/transfers/transitous-mapper.ts mapPlanResponseToTransfer',
		yields: 'some',
		map: (raw) => {
			const transfer = mapPlanResponseToTransfer(
				raw as never,
				BEFORE_DEADLINE,
				greatCircleDistanceKm(CITY, AIRPORT)
			);
			return transfer ? 1 : 0;
		}
	}
};

/** Fixtures nothing in `src/` reads yet, each with the reason. An entry here is a claim
 * that no code path can accept this file, not permission to leave one unchecked. */
const UNREAD: Record<string, string> = {
	'markers.json': 'the marker manifest itself, not a provider payload',
	'rome2rio/search.json':
		'no Rome2Rio adapter exists (issue #7), and RapidAPI has delisted the API — ' +
		'docs/PROVIDERS.md "Rome2Rio cannot be subscribed to". Delete this fixture with the ' +
		'mock if #7 is abandoned; give it a check above when #7 lands.'
};

test.describe('every fixture survives the code that reads it (issue #242)', () => {
	test('every fixture is accounted for, either checked below or listed as unread', () => {
		const onDisk = findFixtures(fixturesDir);
		const accounted = new Set([...Object.keys(CHECKS), ...Object.keys(UNREAD)]);
		const unaccounted = onDisk.filter((relative) => !accounted.has(relative));
		const missing = [...accounted].filter((relative) => !onDisk.includes(relative));

		expect(
			unaccounted,
			'These fixtures are not run through any mapper:\n' +
				unaccounted.join('\n') +
				'\nAdd a CHECKS entry naming the code that reads this shape, or a UNREAD entry ' +
				'saying why nothing does. A fixture no mapper has ever accepted is how issue ' +
				'#194 hid: see this file\'s header.'
		).toEqual([]);
		expect(missing, `These fixtures are listed here but not on disk: ${missing.join(', ')}`).toEqual(
			[]
		);
	});

	for (const [relative, check] of Object.entries(CHECKS)) {
		test(`${relative} is readable by ${check.readBy}`, async () => {
			const produced = await check.map(load(relative));
			if (check.yields === 'some') {
				expect(
					produced,
					`${check.readBy} produced nothing from this fixture. Either the fixture has ` +
						'drifted from the response shape the adapter reads, or the adapter has. ' +
						'Compare it against the captured response in src/lib/providers/*/fixtures/.'
				).toBeGreaterThan(0);
			} else {
				expect(
					produced,
					`${relative} is a deliberate empty answer, so ${check.readBy} should accept it ` +
						'and produce nothing.'
				).toBe(0);
			}
		});
	}
});
