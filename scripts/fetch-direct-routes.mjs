#!/usr/bin/env node
// Issue #361: vendors an all-carrier direct-route graph into static JSON, the same
// build-time pattern scripts/fetch-ryanair-network.mjs uses for Ryanair's network and
// scripts/prepare-airport-terminals.mjs uses for the Overpass terminal table.
//
// Why this exists. Every stopover candidate used to start life in the origin's own
// direct-destination list, and for Boa Vista that list is Kiwi's
// `onewayOnePerCityItineraries` answer: a price-sorted, aggregator-capped sample of 20
// rows, not a route graph. East Midlands is not in it and East Midlands is nobody's
// metro sibling, so no search could ever propose it -- while Kiwi sells BVC to EMA (TUI
// BY 725, EUR 257) and EMA to PFO (TUI BY 7666/7784, from EUR 77), both measured live on
// 2026-09-05. The app could confirm that route and could not think of it. This graph is
// where such a candidate now comes from.
//
// Source: English Wikipedia's `{{Airport-dest-list}}` tables, read through the MediaWiki
// API, joined to IATA codes through Wikidata's P238. Wikipedia text is CC BY-SA 4.0, so
// the generated file is too -- see src/lib/data/direct-routes.LICENSE.md. Wikidata is
// CC0. Both are keyless: no token, no secret, nothing to redact. Wikimedia does require a
// descriptive User-Agent and answers 403 without one.
//
// The output is committed so `pnpm build` never depends on the network, and refreshed
// weekly in CI (.github/workflows/direct-routes.yml) because a hand-edited encyclopedia
// lags a schedule change by days rather than minutes.
//
// The parsing rule lives in direct-routes-parser.mjs and is separately tested, for the
// same reason terminal-match.mjs is split from its runner: a wikitext table that quietly
// yields the wrong airports is worse than no table, because the search would then propose
// a stopover with total confidence.
//
// Usage: node scripts/fetch-direct-routes.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { destinationTitlesFrom } from './direct-routes-parser.mjs';

const RYANAIR_PATH = fileURLToPath(
	new URL('../src/lib/data/ryanair-network.generated.json', import.meta.url)
);
const CHEAP_ROUTES_PATH = fileURLToPath(
	new URL('../src/lib/data/cheap-routes.generated.json', import.meta.url)
);
const FALLBACK_PATH = fileURLToPath(
	new URL('../src/lib/algorithm/connections-fallback-data.ts', import.meta.url)
);
const AIRPORTS_PATH = fileURLToPath(
	new URL('../src/lib/data/airports.generated.json', import.meta.url)
);
const OUTPUT_PATH = fileURLToPath(
	new URL('../src/lib/data/direct-routes.generated.json', import.meta.url)
);
const AUDIT_PATH = fileURLToPath(
	new URL('../src/lib/data/direct-routes.audit.tsv', import.meta.url)
);

const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const MEDIAWIKI_API_URL = 'https://en.wikipedia.org/w/api.php';
const ARTICLE_PREFIX = 'https://en.wikipedia.org/wiki/';

// Wikimedia's user-agent policy asks for something that identifies the tool and gives a
// way to contact whoever runs it. An anonymous or browser-shaped agent gets a 403 here,
// which reads as an outage rather than as a policy refusal.
const USER_AGENT =
	'flights/0.0.1 (https://github.com/mauriciabad/flights) build-time route graph';

/** The API's own ceiling for an anonymous client. Asking for more silently truncates the
 * batch, which would look like a set of airports that have no article. */
const TITLES_PER_REQUEST = 50;

/** Between requests, so 40-odd calls to a donation-funded API arrive as a trickle. This
 * script runs weekly, so a minute either way costs nothing. */
const REQUEST_GAP_MS = 300;

/**
 * The floors this snapshot has to clear to be allowed to replace the committed one.
 *
 * Measured 2026-09-05: 309 airports and 8,111 undirected pairs. These sit far below that
 * for the same reason `fetch-ryanair-network.mjs`'s do: they exist to catch a truncated or
 * reshaped upstream response, not to pin the size of the world's route network. A silently
 * thinned graph here reads on screen as "this app cannot find any connections", which is
 * indistinguishable from the search being broken.
 */
const MIN_AIRPORTS = 250;
const MIN_UNDIRECTED_PAIRS = 5000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every airport code the bundled sources already name, dropped to the ones the airport
 * dataset can place.
 *
 * This is the honest ceiling on what this file can ever add, and it is deliberate: the
 * graph adds EDGES, never AIRPORTS. An airport no bundled source has ever named still
 * cannot become a stopover, because `connections.ts` would have no geography with which to
 * rank it and no provider that has heard of it. Measured 2026-09-05: 330 codes named, 310
 * placeable, 20 dropped -- ANK BAK BUE BUH DKR EAP IZM LON MIL MMA MOW NYC PAR RIO ROM SAO
 * SEL STO TCI YTO, every one an IATA metropolitan code covering several airports at once,
 * the same class `connections.ts` already filters out at "an IATA *metropolitan* code".
 */
async function readSeedCodes() {
	const ryanair = JSON.parse(await readFile(RYANAIR_PATH, 'utf-8'));
	const cheapRoutes = JSON.parse(await readFile(CHEAP_ROUTES_PATH, 'utf-8'));
	const fallbackSource = await readFile(FALLBACK_PATH, 'utf-8');
	const airports = JSON.parse(await readFile(AIRPORTS_PATH, 'utf-8'));

	const named = new Set();
	for (const [origin, destinations] of Object.entries(ryanair.destinationsByOrigin)) {
		named.add(origin);
		for (const destination of destinations) named.add(destination);
	}
	for (const route of cheapRoutes.routes) {
		named.add(route.origin);
		named.add(route.destination);
	}
	// A .mjs build script cannot import the TS module that owns `EDGES`, so the codes are
	// read out of its source. Scoped to the `EDGES` literal rather than the whole file so
	// `FALLBACK_AIRPORTS` below it cannot widen the seed on its own: an airport with
	// geography but no route is not something this graph should be asked about.
	const edgesStart = fallbackSource.indexOf('const EDGES');
	const edgesEnd = fallbackSource.indexOf('];', edgesStart);
	if (edgesStart === -1 || edgesEnd === -1) {
		throw new Error(`Could not find the EDGES literal in ${FALLBACK_PATH}`);
	}
	for (const [, code] of fallbackSource.slice(edgesStart, edgesEnd).matchAll(/'([A-Z]{3})'/g)) {
		named.add(code);
	}

	const placeable = new Set(airports.map((airport) => airport.iataCode));
	const seed = [...named].filter((code) => placeable.has(code)).sort();
	console.log(
		`Seed: ${named.size} codes named by the bundled sources, ${seed.length} placeable, ${
			named.size - seed.length
		} dropped as unplaceable`
	);
	return seed;
}

/**
 * IATA code to the English Wikipedia articles about it, from Wikidata's P238.
 *
 * One query for every airport on Wikidata rather than 310 lookups: the whole join is 8,347
 * rows and about a second, and the same result also gives the reverse map that turns a
 * wikilink target back into a code.
 */
async function fetchArticleTitles() {
	const query = `SELECT ?code ?article WHERE {
  ?airport wdt:P238 ?code .
  ?article schema:about ?airport ; schema:isPartOf <https://en.wikipedia.org/> .
}`;
	const url = `${WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`;
	const response = await fetch(url, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' }
	});
	if (!response.ok) {
		throw new Error(
			`Wikidata returned ${response.status} ${response.statusText} for the P238 query`
		);
	}
	const json = await response.json();
	const rows = json?.results?.bindings ?? [];
	if (rows.length === 0) {
		throw new Error('Wikidata returned no IATA codes; refusing to overwrite the snapshot');
	}

	const titlesByCode = new Map();
	const codesByTitle = new Map();
	for (const row of rows) {
		const code = row.code?.value?.trim().toUpperCase();
		const articleUrl = row.article?.value;
		if (!code || !/^[A-Z]{3}$/.test(code) || !articleUrl?.startsWith(ARTICLE_PREFIX)) continue;
		const title = decodeURIComponent(articleUrl.slice(ARTICLE_PREFIX.length)).replace(/_/g, ' ');
		if (!titlesByCode.has(code)) titlesByCode.set(code, []);
		titlesByCode.get(code).push(title);
		// Two titles in the whole set carry more than one code, and both are one physical
		// airport with several: Basel-Mulhouse is BSL and MLH and EAP, Doncaster Sheffield is
		// DSA and DCS. Recording the edge under each is right rather than a duplication, so
		// this keeps every code instead of picking one.
		if (!codesByTitle.has(title)) codesByTitle.set(title, []);
		codesByTitle.get(title).push(code);
	}
	for (const titles of titlesByCode.values()) titles.sort();
	console.log(`Wikidata: ${rows.length} P238 rows, ${titlesByCode.size} codes with an article`);
	return { titlesByCode, codesByTitle };
}

async function queryMediaWiki(params) {
	const body = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
	const response = await fetch(MEDIAWIKI_API_URL, {
		method: 'POST',
		headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!response.ok) {
		throw new Error(`Wikipedia returned ${response.status} ${response.statusText}`);
	}
	return response.json();
}

/** Current wikitext for each title, `redirects=1` so a title that has been renamed lands on
 * the article rather than on a one-line stub. */
async function fetchWikitext(titles) {
	const pages = new Map();
	for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
		const batch = titles.slice(i, i + TITLES_PER_REQUEST);
		const json = await queryMediaWiki({
			action: 'query',
			prop: 'revisions',
			rvprop: 'content',
			rvslots: 'main',
			redirects: '1',
			titles: batch.join('|')
		});
		// A redirect or a normalisation means the page came back under a different title than
		// the one asked for, so the caller's title has to be pointed at the content rather
		// than looked up and missed.
		const landedOn = new Map();
		for (const step of json?.query?.normalized ?? []) landedOn.set(step.from, step.to);
		for (const step of json?.query?.redirects ?? []) landedOn.set(step.from, step.to);
		const byTitle = new Map();
		for (const page of json?.query?.pages ?? []) {
			if (page.missing) continue;
			byTitle.set(page.title, page.revisions?.[0]?.slots?.main?.content ?? '');
		}
		for (const title of batch) {
			let landing = title;
			for (let hop = 0; hop < 5 && landedOn.has(landing); hop++) landing = landedOn.get(landing);
			const content = byTitle.get(landing);
			if (content) pages.set(title, content);
		}
		await sleep(REQUEST_GAP_MS);
	}
	return pages;
}

/**
 * The canonical article title each wikilink target lands on.
 *
 * Load-bearing, because the tables link through redirects constantly: Boa Vista's own page
 * writes `[[Milan-Malpensa]]` and `[[Rome-Fiumicino]]`, neither of which is the article
 * title Wikidata carries a code for. Only the targets that are not already canonical are
 * sent, which is roughly half of them.
 */
async function resolveRedirects(targets) {
	const canonical = new Map();
	for (let i = 0; i < targets.length; i += TITLES_PER_REQUEST) {
		const batch = targets.slice(i, i + TITLES_PER_REQUEST);
		const json = await queryMediaWiki({ action: 'query', redirects: '1', titles: batch.join('|') });
		const landedOn = new Map();
		for (const step of json?.query?.normalized ?? []) landedOn.set(step.from, step.to);
		for (const step of json?.query?.redirects ?? []) landedOn.set(step.from, step.to);
		for (const target of batch) {
			let landing = target;
			for (let hop = 0; hop < 5 && landedOn.has(landing); hop++) landing = landedOn.get(landing);
			canonical.set(target, landing);
		}
		await sleep(REQUEST_GAP_MS);
	}
	return canonical;
}

async function main() {
	const seedCodes = await readSeedCodes();
	const seed = new Set(seedCodes);
	const { titlesByCode, codesByTitle } = await fetchArticleTitles();

	const wantedTitles = [
		...new Set(seedCodes.flatMap((code) => titlesByCode.get(code) ?? []))
	].sort();
	console.log(`Fetching ${wantedTitles.length} articles for ${seedCodes.length} seed airports`);
	const pages = await fetchWikitext(wantedTitles);
	console.log(`Fetched ${pages.size} articles`);

	const targetsByTitle = new Map();
	for (const [title, wikitext] of pages) targetsByTitle.set(title, destinationTitlesFrom(wikitext));

	// Fourteen seed codes carry a second article: a decommissioned predecessor, a colocated
	// air base, or in one case a railway station. Exactly one of each pair has a destination
	// table, so taking the article that parsed the most targets picks the operating airport
	// every time, and the title sort behind it keeps the choice reproducible.
	const articleByCode = new Map();
	for (const code of seedCodes) {
		const candidates = (titlesByCode.get(code) ?? []).filter((title) => pages.has(title));
		if (candidates.length === 0) continue;
		const best = candidates.reduce((a, b) =>
			(targetsByTitle.get(b) ?? []).length > (targetsByTitle.get(a) ?? []).length ? b : a
		);
		articleByCode.set(code, best);
	}

	const allTargets = [
		...new Set([...articleByCode.values()].flatMap((title) => targetsByTitle.get(title) ?? []))
	].sort();
	const needResolving = allTargets.filter((target) => !codesByTitle.has(target));
	console.log(
		`Resolving ${needResolving.length} of ${allTargets.length} link targets through redirects`
	);
	const canonical = await resolveRedirects(needResolving);
	const codesOfTarget = (target) =>
		codesByTitle.get(codesByTitle.has(target) ? target : (canonical.get(target) ?? target)) ?? [];

	// Symmetrise. An edge recorded on either article counts for both, and this is what makes
	// the issue's own route work: Boa Vista's page lists East Midlands under TUI Airways,
	// East Midlands' page lists both Boa Vista and Paphos, and the search needs all three
	// edges from tables that each hold only some of them.
	const neighbours = new Map();
	const link = (a, b) => {
		if (a === b) return;
		if (!neighbours.has(a)) neighbours.set(a, new Set());
		neighbours.get(a).add(b);
	};
	const unresolvedMentions = new Map();
	for (const [code, title] of articleByCode) {
		for (const target of targetsByTitle.get(title) ?? []) {
			const others = codesOfTarget(target).filter((other) => seed.has(other));
			if (others.length === 0) {
				// An airline article, a city article or a citation that survived the strip. Counted
				// rather than discarded, so the audit file can show the miss rate as a number.
				unresolvedMentions.set(target, (unresolvedMentions.get(target) ?? 0) + 1);
				continue;
			}
			for (const other of others) {
				link(code, other);
				link(other, code);
			}
		}
	}

	const airports = [...neighbours.keys()].sort();
	const directedEdges = airports.reduce((total, code) => total + neighbours.get(code).size, 0);
	const undirectedPairs = directedEdges / 2;
	if (airports.length < MIN_AIRPORTS || undirectedPairs < MIN_UNDIRECTED_PAIRS) {
		throw new Error(
			`Graph looks truncated: ${airports.length} airports (floor ${MIN_AIRPORTS}), ` +
				`${undirectedPairs} undirected pairs (floor ${MIN_UNDIRECTED_PAIRS}). Refusing to write.`
		);
	}

	const snapshot = {
		fetchedAt: new Date().toISOString(),
		neighbours: Object.fromEntries(
			airports.map((code) => [code, [...neighbours.get(code)].sort()])
		)
	};
	const json = JSON.stringify(snapshot);
	await writeFile(OUTPUT_PATH, json);

	const audit = [
		['iata', 'article', 'parsed_targets', 'shipped_degree', 'has_destination_table'].join('\t')
	];
	for (const code of seedCodes) {
		const title = articleByCode.get(code);
		const parsed = title ? (targetsByTitle.get(title) ?? []) : [];
		audit.push(
			[
				code,
				title ?? '(no article)',
				parsed.length,
				neighbours.get(code)?.size ?? 0,
				parsed.length > 0 ? 'yes' : 'no'
			].join('\t')
		);
	}
	audit.push('');
	audit.push('# Wikilink targets that resolved to no seed IATA code, most mentioned first.');
	audit.push('# Two populations, and the counts disagree about which dominates. Most of the');
	audit.push('# distinct targets are airports outside the seed, and most of the mentions are');
	audit.push('# airlines, because the airline shares column one of every row in the table.');
	audit.push('# Neither is a parse failure. Measured 2026-09-05: 2,108 distinct targets over');
	audit.push('# 13,662 mentions, of which 1,511 distinct (6,453 mentions) are airport-shaped.');
	audit.push(['target', 'mentions'].join('\t'));
	for (const [target, mentions] of [...unresolvedMentions].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
	)) {
		audit.push([target, mentions].join('\t'));
	}
	await writeFile(AUDIT_PATH, `${audit.join('\n')}\n`);

	const bytes = Buffer.byteLength(json, 'utf-8');
	console.log(
		`Wrote ${airports.length} airports, ${undirectedPairs} undirected pairs, ` +
			`${directedEdges} directed edges (${(bytes / 1024).toFixed(1)} KB) to ${OUTPUT_PATH}`
	);
	console.log(
		`Wrote ${seedCodes.length} audit rows and ${unresolvedMentions.size} unresolved targets to ${AUDIT_PATH}`
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
