/**
 * Is a stitched transit time (MOTIS one-to-all to a stop, plus an OSRM walk from that stop)
 * good enough to put on thirty stay rows, instead of leaving the column empty?
 *
 *   node .audit/probe-transit-stitch-agent-acc83cf3.mjs
 *
 * Two questions decide it, and both are about the list rather than any one row.
 *
 *   1. COVERAGE. How many candidate properties have a reachable stop close enough that a
 *      walk from it is plausible at all. If most do not, the column is empty either way.
 *   2. ERROR AND ORDER. How far the stitched figure sits from what MOTIS `/plan` actually
 *      answers for the same pair, and — the part that matters for a sort key — whether the
 *      two orderings agree about which bed is closer by bus.
 *
 * Every provider here is free and keyless. The `/plan` calls are the expensive half against
 * a volunteer-run service, so they are spaced and capped.
 */
import { greatCircleDistanceKm } from '../src/lib/domain/coordinates.ts';

const AIRPORT = { latitude: 48.3538, longitude: 11.7861, name: 'Munich airport (MUC)' };
const CITY_ID = 20; // Hostelworld"s Munich (resolved from /2.2/continents/3/countries/), the BCN->OTP stopover.
const PLAN_SAMPLE = 8;
const MAX_STOP_WALK_KM = 1.0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Node sends its own User-Agent and api.transitous.org answers that with a 403 while
// answering curl and a browser with a 200. Same shape as AGENTS.md's Kiwi note: a provider
// that looks down from one runtime and up from another is a header, not an outage.
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function json(url) {
	const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
	if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
	return response.json();
}

// --- the real candidate list, from the adapter's own endpoint ------------------------
const stayUrl =
	`https://api.m.hostelworld.com/2.2/cities/${CITY_ID}/properties/` +
	`?currency=EUR&date-start=2026-10-07&num-nights=1&guests=1&per-page=30&show-rooms=1&sort=price`;
const stays = await json(stayUrl);
const properties = (stays.properties ?? [])
	.map((property) => ({
		name: property.name,
		latitude: Number(property.latitude),
		longitude: Number(property.longitude)
	}))
	.filter((property) => Number.isFinite(property.latitude) && Number.isFinite(property.longitude))
	.filter((property) => property.latitude !== 0 || property.longitude !== 0);
console.log(`properties: ${properties.length}`);

// --- one request: transit time from the airport to every reachable stop ---------------
const oneToAll = await json(
	'https://api.transitous.org/api/v1/one-to-all' +
		`?one=${AIRPORT.latitude},${AIRPORT.longitude}` +
		'&maxTravelTime=90&time=2026-10-07T09:00:00Z&arriveBy=false'
);
const stops = (oneToAll.all ?? [])
	.map((entry) => ({
		name: entry.place?.name,
		latitude: Number(entry.place?.lat),
		longitude: Number(entry.place?.lon),
		// MOTIS reports an arrival instant per stop, not a duration, so the ride is that
		// minus the departure this query named.
		minutes:
			entry.place?.arrival !== undefined
				? (Date.parse(entry.place.arrival) - Date.parse('2026-10-07T09:00:00Z')) / 60000
				: undefined
	}))
	.filter((stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.minutes));
console.log(`reachable stops within 90 min: ${stops.length}`);
if (stops.length > 0) {
	console.log(`  sample: ${stops.slice(0, 3).map((s) => `${s.name} ${s.minutes.toFixed(0)}m`).join(' | ')}`);
}

// --- coverage --------------------------------------------------------------------------
function nearestStop(property) {
	let best;
	for (const stop of stops) {
		const km = greatCircleDistanceKm(property, stop);
		if (!best || km < best.km) best = { stop, km };
	}
	return best;
}

const withStop = properties.map((property) => ({ property, nearest: nearestStop(property) }));
const covered = withStop.filter((row) => row.nearest && row.nearest.km <= MAX_STOP_WALK_KM);
console.log(
	`\nCOVERAGE: ${covered.length} of ${properties.length} properties have a reachable stop within ${MAX_STOP_WALK_KM} km`
);
for (const row of withStop.slice(0, 10)) {
	console.log(
		`  ${row.property.name.slice(0, 34).padEnd(34)} nearest stop ${row.nearest ? `${row.nearest.km.toFixed(2)} km, ${row.nearest.stop.minutes.toFixed(0)}m by transit` : 'none'}`
	);
}

// --- one request: walking time from each nearest stop to its property -------------------
// OSRM's table service takes sources and destinations, so the whole column is one request.
const sample = covered.slice(0, PLAN_SAMPLE);
let stitched = [];
if (sample.length > 0) {
	const points = sample.flatMap((row) => [row.nearest.stop, row.property]);
	const coords = points.map((point) => `${point.longitude},${point.latitude}`).join(';');
	const sources = sample.map((_, index) => index * 2).join(';');
	const destinations = sample.map((_, index) => index * 2 + 1).join(';');
	const table = await json(
		`https://routing.openstreetmap.de/routed-foot/table/v1/foot/${coords}` +
			`?sources=${sources}&destinations=${destinations}&annotations=duration`
	);
	stitched = sample.map((row, index) => ({
		...row,
		walkMinutes: table.durations[index][index] / 60,
		stitchedMinutes: row.nearest.stop.minutes + table.durations[index][index] / 60
	}));
}

// --- N requests: what MOTIS actually answers door to door -------------------------------
const truth = [];
for (const row of stitched) {
	const plan = await json(
		'https://api.transitous.org/api/v1/plan' +
			`?fromPlace=${AIRPORT.latitude},${AIRPORT.longitude}` +
			`&toPlace=${row.property.latitude},${row.property.longitude}` +
			'&time=2026-10-07T09:00:00Z&numItineraries=3'
	);
	const best = (plan.itineraries ?? [])
		.map((itinerary) => Number(itinerary.duration) / 60)
		.filter(Number.isFinite)
		.sort((a, b) => a - b)[0];
	truth.push({ ...row, planMinutes: best });
	await sleep(1200);
}

console.log('\nERROR: stitched (ride + walk, no wait) against what /plan answers door to door');
console.log('  property                            stitched   plan   difference');
for (const row of truth) {
	console.log(
		`  ${row.property.name.slice(0, 34).padEnd(34)} ${row.stitchedMinutes.toFixed(0).padStart(6)}m ${
			row.planMinutes === undefined ? '   n/a' : `${row.planMinutes.toFixed(0).padStart(6)}m`
		} ${row.planMinutes === undefined ? '' : `${(row.planMinutes - row.stitchedMinutes).toFixed(0).padStart(8)}m`}`
	);
}

const comparable = truth.filter((row) => row.planMinutes !== undefined);
if (comparable.length > 1) {
	const gaps = comparable.map((row) => row.planMinutes - row.stitchedMinutes);
	const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
	console.log(`\n  understatement: mean ${mean.toFixed(1)}m, min ${Math.min(...gaps).toFixed(0)}m, max ${Math.max(...gaps).toFixed(0)}m`);
	console.log(`  spread of the understatement: ${(Math.max(...gaps) - Math.min(...gaps)).toFixed(0)}m`);

	const byStitched = [...comparable].sort((a, b) => a.stitchedMinutes - b.stitchedMinutes).map((r) => r.property.name);
	const byPlan = [...comparable].sort((a, b) => a.planMinutes - b.planMinutes).map((r) => r.property.name);
	const agree = byStitched.filter((name, index) => name === byPlan[index]).length;
	console.log(`\n  ORDER: ${agree} of ${comparable.length} rows land in the same position under both`);
	console.log(`  by stitched: ${byStitched.map((n) => n.slice(0, 18)).join(' > ')}`);
	console.log(`  by plan    : ${byPlan.map((n) => n.slice(0, 18)).join(' > ')}`);
}
