/**
 * Reads a real Hostelworld city response and reports what it says about female-only
 * dorms: how many properties carry one, whether the room-level fields the mapper reads
 * are present, and what the property-level "cheapest dorm" figure is against the
 * cheapest female room.
 *
 * Issue #288 was filed off the app's own IndexedDB cache, which is a copy of this
 * response. This asks the host directly so a claim about the payload can be re-checked
 * without a search, a cache and a browser profile in between.
 *
 * The fetch runs from a real page origin rather than from node, for the reason
 * `probe-cors.mjs` exists: what curl can reach and what a browser document can reach are
 * different questions, and this app only ever gets the second one.
 *
 * Keyless. `api.m.hostelworld.com` answers an anonymous, header-free request. See
 * `src/lib/providers/stays/hostelworld-client.ts`. Nothing here spends anybody's quota.
 *
 * Usage: node tools/probe-female-dorms.mjs [city] [YYYY-MM-DD] [nights]
 *   node tools/probe-female-dorms.mjs Rome 2026-10-06 3
 *
 * Writes the raw response to PROBE_OUT (default: the repo's tmp dir) so a fixture can be
 * cut from it, and prints the counts to stdout.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { newProbeContext } from './probe-browser.mjs';

const CITY = process.argv[2] ?? 'Rome';
const DATE_START = process.argv[3] ?? '2026-10-06';
const NIGHTS = Number(process.argv[4] ?? 3);
const PORT = Number(process.env.PROBE_PORT ?? 8791);
const OUT = process.env.PROBE_OUT ?? `/tmp/hostelworld-${CITY.toLowerCase()}-raw.json`;

const server = createServer((_req, res) => {
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<!doctype html><title>hostelworld probe</title><body>probe origin</body>');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'domcontentloaded' });

const cityId = await page.evaluate(async (wanted) => {
	// Europe is continent 3. The city index is the same one hostelworld.ts caches.
	const res = await fetch('https://api.m.hostelworld.com/2.2/continents/3/countries/');
	const body = await res.json();
	for (const country of body.countries ?? []) {
		for (const city of country.cities ?? []) {
			if (city.name === wanted) return city.id;
		}
	}
	return undefined;
}, CITY);

if (cityId === undefined) {
	console.error(`No Hostelworld city named ${CITY} in Europe.`);
	await browser.close();
	server.close();
	process.exit(1);
}

const raw = await page.evaluate(
	async ({ id, dateStart, nights }) => {
		// The exact query hostelworld-client.ts sends, `show-rooms=1` included.
		const query = new URLSearchParams({
			currency: 'EUR',
			'date-start': dateStart,
			'num-nights': String(nights),
			guests: '1',
			'per-page': '30',
			'show-rooms': '1',
			sort: 'price'
		});
		const res = await fetch(
			`https://api.m.hostelworld.com/2.2/cities/${id}/properties/?${query.toString()}`
		);
		return { status: res.status, body: await res.text() };
	},
	{ id: cityId, dateStart: DATE_START, nights: NIGHTS }
);

await browser.close();
server.close();

if (raw.status !== 200) {
	console.error(`HTTP ${raw.status}: ${raw.body.slice(0, 400)}`);
	process.exit(1);
}

const parsed = JSON.parse(raw.body);
writeFileSync(OUT, JSON.stringify(parsed, null, 1));

const properties = parsed.properties ?? [];
const basicTypes = new Map();
let withFemaleRoom = 0;
let femaleRoomsMissingCapacity = 0;
let dormPriceWithNoRoomList = 0;
const cheapestIsFemale = [];
/** Issue #288's root cause, counted: a property-level `lowestAverageDormPricePerNight`
 * whose room list holds no mixed dorm at all. The mapper turns that figure into a
 * `dorm` Stay, so every one of these is a mixed-dorm bed on screen that the payload says
 * does not exist. */
const dormPriceWithNoMixedRoom = [];
const restricted = (room) => /^(fe)?male dorm$/i.test((room.basicType ?? '').trim());

for (const property of properties) {
	const dorms = property.rooms?.dorms ?? [];
	const propertyDormPrice = property.lowestAverageDormPricePerNight?.value;
	if (propertyDormPrice && dorms.length === 0) dormPriceWithNoRoomList += 1;
	if (propertyDormPrice && dorms.length > 0 && dorms.every(restricted)) {
		dormPriceWithNoMixedRoom.push({
			name: property.name,
			soldAsMixedDorm: propertyDormPrice,
			everyListedDorm: dorms.map((room) => room.basicType)
		});
	}
	for (const room of [...dorms, ...(property.rooms?.privates ?? [])]) {
		const type = room.basicType ?? '(absent)';
		basicTypes.set(type, (basicTypes.get(type) ?? 0) + 1);
	}
	const female = dorms.filter((room) => /female/i.test(room.basicType ?? ''));
	if (female.length === 0) continue;
	withFemaleRoom += 1;
	femaleRoomsMissingCapacity += female.filter(
		(room) => !Number.isInteger(Number(room.capacity))
	).length;

	const price = (room) => Number(room.averagePrice?.value);
	const cheapestFemale = Math.min(...female.map(price));
	const mixed = dorms.filter((room) => !/female/i.test(room.basicType ?? ''));
	const cheapestMixed = mixed.length > 0 ? Math.min(...mixed.map(price)) : Infinity;
	if (cheapestFemale < cheapestMixed) {
		cheapestIsFemale.push({
			name: property.name,
			female: cheapestFemale,
			mixed: Number.isFinite(cheapestMixed) ? cheapestMixed : null,
			propertyLevelDorm: property.lowestAverageDormPricePerNight?.value ?? null
		});
	}
}

console.log(
	JSON.stringify(
		{
			city: CITY,
			cityId,
			dateStart: DATE_START,
			nights: NIGHTS,
			savedTo: OUT,
			properties: properties.length,
			withFemaleRoom,
			femaleRoomsMissingCapacity,
			dormPriceWithNoRoomList,
			dormPriceWithNoMixedRoom,
			basicTypes: Object.fromEntries([...basicTypes].sort((a, b) => b[1] - a[1])),
			sampleFemaleRoom: properties
				.flatMap((property) => property.rooms?.dorms ?? [])
				.find((room) => /female/i.test(room.basicType ?? '')),
			cheapestDormIsFemaleAt: cheapestIsFemale
		},
		null,
		1
	)
);
