/**
 * What Hostelworld's per-property availability endpoint costs a page, and whether a page may
 * call it at all. Issue #449.
 *
 * That endpoint is the only place in this repo's three stay providers where a photograph of
 * the ROOM exists (docs/PROVIDERS.md, "Which providers photograph the room"). Nothing here
 * has ever called it, so two things had to be measured before anything was built on it.
 *
 * **CORS, from a browser.** A page is served from a real `http://` origin and `fetch` runs
 * inside that document, which is the only caller whose answer means anything. `curl` never
 * runs a preflight and never enforces `Access-Control-Allow-Origin`, and this exact question
 * has already been got wrong here in both directions: Hostelworld's autocomplete host answers
 * `curl` with 200 and a browser with no ACAO header at all, and `api.skypicker.com` answers a
 * headless User-Agent with 403 while giving a real one a 200. So this reports what the page
 * observed AND what the wire carried, and it goes out behind `probe-browser.mjs`'s Chrome
 * User-Agent.
 *
 * **The page cost.** One request per property, against a search that today costs one request
 * per city. This times a whole page of thirty and one property alone, so the difference
 * between fetching eagerly for a list and fetching when a reader opens one property is a
 * number rather than an opinion. Bytes are reported twice, decoded and over the wire, because
 * a 44 KB JSON body that gzips to 8 KB is two different arguments.
 *
 * Hostelworld is keyless and free, so a run of this spends nobody's quota. It is still 31
 * requests, so `--properties=N` takes a cheaper sample.
 *
 * Usage: node tools/probe-hostelworld-rooms.mjs [--properties=30] [--city=3] [--nights=3]
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { newProbeContext } from './probe-browser.mjs';

const ENDPOINT = 'https://api.m.hostelworld.com/2.2';

const arg = (name, fallback) => {
	const found = process.argv.find((value) => value.startsWith(`--${name}=`));
	return found ? found.slice(name.length + 3) : fallback;
};

/** London. The city every other Hostelworld measurement in docs/PROVIDERS.md was taken
 * against, so this run's numbers sit beside them rather than beside nothing. */
const CITY_ID = Number(arg('city', 3));
const WANTED = Number(arg('properties', 30));
const NIGHTS = Number(arg('nights', 3));
const CURRENCY = 'EUR';

/** Far enough out that every property still has availability, which is what makes the sample
 * thirty properties rather than the handful that happen to have a free bed tomorrow. */
const dateStart = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);

const cityUrl = `${ENDPOINT}/cities/${CITY_ID}/properties/?${new URLSearchParams({
	currency: CURRENCY,
	'date-start': dateStart,
	'num-nights': String(NIGHTS),
	guests: '1',
	'per-page': String(WANTED),
	'show-rooms': '1',
	sort: 'price'
})}`;

const availabilityUrl = (id) =>
	`${ENDPOINT}/properties/${id}/availability/?${new URLSearchParams({
		currency: CURRENCY,
		'date-start': dateStart,
		'num-nights': String(NIGHTS),
		guests: '1'
	})}`;

const server = createServer((_request, response) => {
	response.writeHead(200, { 'content-type': 'text/html' });
	response.end('<!doctype html><title>hostelworld rooms probe</title><body>probe origin</body>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const context = await newProbeContext(browser);
const page = await context.newPage();

/** The wire, captured outside the CORS sandbox: every header, including the ones CORS hides
 * from script, plus the encoded body size the socket actually carried. */
const wire = new Map();
page.on('response', (response) => {
	if (response.url().startsWith(ORIGIN)) return;
	wire.set(response.url(), response);
});
const failures = [];
page.on('requestfailed', (request) => {
	if (request.url().startsWith(ORIGIN)) return;
	failures.push({ url: request.url(), error: request.failure()?.errorText });
});

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });

/** One fetch, reported the way a page sees it. `type` is the load-bearing field: `cors` means
 * the browser let script read the body, `opaque` means it did not. */
const fetchFromPage = (url) =>
	page.evaluate(async (target) => {
		const started = performance.now();
		try {
			const response = await fetch(target);
			const text = await response.text();
			return {
				ok: response.ok,
				status: response.status,
				type: response.type,
				decodedBytes: new TextEncoder().encode(text).length,
				ms: Math.round(performance.now() - started),
				body: text
			};
		} catch (error) {
			return { ok: false, threw: String(error), ms: Math.round(performance.now() - started) };
		}
	}, url);

const wireFacts = async (url) => {
	const response = wire.get(url);
	if (!response) return { seenOnTheWire: false };
	const headers = response.headers();
	const sizes = await response.request().sizes();
	return {
		status: response.status(),
		accessControlAllowOrigin: headers['access-control-allow-origin'] ?? null,
		contentEncoding: headers['content-encoding'] ?? null,
		wireBytes: sizes.responseBodySize
	};
};

const report = { pageOrigin: ORIGIN, dateStart, city: CITY_ID, nights: NIGHTS };

// The request the app already makes, so the new one has something to be compared against.
const city = await fetchFromPage(cityUrl);
report.citySearch = { url: cityUrl, ...city, body: undefined, ...(await wireFacts(cityUrl)) };

const properties = JSON.parse(city.body).properties ?? [];
const ids = properties.map((property) => property.id).filter((id) => id !== undefined);
report.citySearch.propertiesReturned = ids.length;

/** One property, cold, on its own. This is the number that matters, because fetching when a
 * reader opens a property is one of these and never thirty. */
const first = await fetchFromPage(availabilityUrl(ids[0]));
const roomsOf = (body) => {
	const parsed = JSON.parse(body);
	const rooms = [...(parsed.rooms?.dorms ?? []), ...(parsed.rooms?.privates ?? [])];
	const addresses = new Set();
	for (const room of rooms) {
		for (const image of room.images ?? []) addresses.add(`${image.prefix ?? ''}${image.suffix ?? ''}`);
	}
	return {
		rooms: rooms.length,
		roomsWithImages: rooms.filter((room) => (room.images ?? []).length > 0).length,
		distinctImageAddresses: addresses.size
	};
};
report.oneProperty = {
	id: ids[0],
	url: availabilityUrl(ids[0]),
	...first,
	body: undefined,
	...(await wireFacts(availabilityUrl(ids[0]))),
	...roomsOf(first.body)
};

/**
 * The whole page at once, which is what "fetch it for every property in the list" means.
 *
 * Started together rather than one after another, because that is what an eager
 * implementation would do and it is the kinder of the two numbers: the browser caps
 * concurrent connections per host at six, so this measures the queue rather than the sum of
 * thirty round trips.
 */
const started = Date.now();
const all = await page.evaluate(async (urls) => {
	const one = async (url) => {
		const begun = performance.now();
		const response = await fetch(url);
		const text = await response.text();
		const parsed = JSON.parse(text);
		const rooms = [...(parsed.rooms?.dorms ?? []), ...(parsed.rooms?.privates ?? [])];
		return {
			status: response.status,
			decodedBytes: new TextEncoder().encode(text).length,
			ms: Math.round(performance.now() - begun),
			rooms: rooms.length,
			roomsWithImages: rooms.filter((room) => (room.images ?? []).length > 0).length
		};
	};
	return Promise.all(urls.map(one));
}, ids.map(availabilityUrl));
const wallClockMs = Date.now() - started;

const wireBytes = [];
for (const id of ids) {
	const facts = await wireFacts(availabilityUrl(id));
	if (typeof facts.wireBytes === 'number') wireBytes.push(facts.wireBytes);
}
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

report.wholePage = {
	requests: all.length,
	wallClockMs,
	decodedBytesTotal: sum(all.map((row) => row.decodedBytes)),
	decodedBytesMedian: median(all.map((row) => row.decodedBytes)),
	wireBytesTotal: sum(wireBytes),
	wireBytesMedian: median(wireBytes),
	msMedian: median(all.map((row) => row.ms)),
	msSlowest: Math.max(...all.map((row) => row.ms)),
	roomsWithImages: sum(all.map((row) => row.roomsWithImages)),
	rooms: sum(all.map((row) => row.rooms)),
	propertiesWhereEveryRoomIsPhotographed: all.filter((row) => row.rooms > 0 && row.rooms === row.roomsWithImages).length,
	propertiesWithNoRoomPhotographAtAll: all.filter((row) => row.roomsWithImages === 0).length,
	statusesOtherThan200: all.filter((row) => row.status !== 200).map((row) => row.status)
};

report.requestFailed = failures;

console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
