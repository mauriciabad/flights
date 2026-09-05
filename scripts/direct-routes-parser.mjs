// Issue #361: turns one English Wikipedia airport article into the wikilink targets its
// passenger destination table names. Pure, and split out from its fetch runner for the
// same reason cheap-routes-parser.mjs is: this is where a wrong answer would hide. A route
// invented here does not fail loudly anywhere, it becomes a connection the app offers a
// traveller who then cannot buy it.
//
// Every article carries an `{{Airport-dest-list}}` template whose body names, as wikilinks,
// every airport an airline flies to from there. Turning those titles into IATA codes is the
// runner's job. Nothing in this file has ever seen a network, a file or an airport code.

/**
 * Removes `<ref>` citations and HTML comments from a whole article.
 *
 * Run this before anything counts a brace. The order is the single load-bearing thing in
 * the file, because Wikipedia's own source is not well formed: the Milan Bergamo article
 * carries `<ref>{{cite web | url=... | </ref>`, a template that opens and never closes.
 * Match braces first and that one template swallows every remaining `}}` on the page, so
 * the destination table has no end and the airport contributes nothing at all. Stripping
 * the ref deletes the broken template inside it. BGY, OSL and SNN all came back when these
 * two steps were put in this order, and BGY is the airport issue #340 exists about.
 */
export function stripCitations(wikitext) {
	return (
		wikitext
			// Self-closing refs go first because `<ref[^>]*>` also matches `<ref name="x"/>`,
			// and a paired strip that started there would run on to the NEXT `</ref>` and take
			// every destination in between with it.
			.replace(/<ref\b[^>]*\/>/gi, '')
			.replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
			.replace(/<!--[\s\S]*?-->/g, '')
	);
}

/** Both spellings are in live use and neither is rare: 250 articles in the captured corpus
 * write `{{Airport-dest-list}}`, 127 write `{{Airport destination list}}`, and 20 of those
 * are lower case. Accepting one of them silently drops a third of the network. */
const DESTINATION_TEMPLATE = /\{\{\s*airport[ _-]dest(?:ination)?[ _-]list\b/gi;

const SECTION_HEADING = /^[ \t]*=+[ \t]*(.+?)[ \t]*=+[ \t]*$/gm;

/**
 * Every passenger destination table in the article, as `{ heading, body }`.
 *
 * `body` is the whole template, outer braces included. `heading` is the nearest section
 * heading above it with its `=` signs taken off, or `''` when the template sits above the
 * first heading on the page.
 */
export function findDestinationTables(wikitext) {
	const text = stripCitations(wikitext);
	const headings = [...text.matchAll(SECTION_HEADING)].map((match) => ({
		index: match.index,
		text: match[1].trim()
	}));

	const tables = [];
	for (const match of text.matchAll(DESTINATION_TEMPLATE)) {
		const end = templateEnd(text, match.index);
		// No article in the corpus needs this today, once the citations are gone. It is here
		// so that one malformed page costs its own routes rather than the whole build.
		if (end === -1) continue;

		const heading = headings.findLast((candidate) => candidate.index < match.index)?.text ?? '';
		// 88 of the 397 templates in the corpus sit under a cargo heading and every row in
		// them is freight. East Midlands' cargo table names Frankfurt, Oslo, Edinburgh,
		// Cologne, Belfast and Abu Dhabi, all airports this app searches and none of them a
		// flight a passenger can board. The only headings that ever appear above one of these
		// templates in the whole corpus are `Airlines and destinations`, `Passenger`,
		// `Cargo`, `Passenger destinations` and `Cargo destinations`, so a prefix test is
		// exact here rather than a guess at what a heading might say.
		if (heading.toLowerCase().startsWith('cargo')) continue;

		tables.push({ heading, body: text.slice(match.index, end) });
	}
	return tables;
}

/** The index just past the template that opens at `start`, or -1 if its braces never
 * balance. A regex cannot do this job: a table body nests cite templates, `{{cn|date=...}}`
 * and `{{nowrap|...}}` several deep, and a lazy `[\s\S]*?\}\}` would end the table at the
 * first inner one. */
function templateEnd(text, start) {
	let depth = 0;
	for (let i = start; i < text.length - 1; i += 1) {
		if (text[i] === '{' && text[i + 1] === '{') {
			depth += 1;
			i += 1;
		} else if (text[i] === '}' && text[i + 1] === '}') {
			depth -= 1;
			i += 1;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * Drops the parts of a table body that add noise and never change which airports are named.
 *
 * Deliberately not modelling seasonality or start dates. A `(begins 29 March 2027)` note
 * does not change whether the route is recorded, because this table is only a claim that a
 * route exists and `src/lib/algorithm/connections.ts` prices every proposal against a live
 * provider downstream anyway.
 */
export function stripEditorialNoise(body) {
	return (
		body
			.replace(/\{\{\s*(?:cn|citation needed|fact)\s*(?:\|[^{}]*)?\}\}/gi, '')
			// A bold run that wraps a wikilink is a destination, not a label, so it stays
			// whole. The corpus holds 207 of those, `'''<small>[[Bram Fischer International
			// Airport|Bloemfontein]]</small>'''` among them, and none of them sits inside a
			// destination table today. So this guard changes no current route, and it is what
			// stops a blanket `'''...'''` strip from deleting an airport on the day one moves.
			.replace(/'''(.*?)'''/g, (bold, inner) => (inner.includes('[[') ? bold : ''))
			.replace(/<br\s*\/?\s*>/gi, '')
			.replace(/\(\s*(?:begins|ends)\b[^()]*\)/gi, '')
	);
}

const WIKILINK = /\[\[([^[\]|]*)(?:\|[^[\]]*)?\]\]/g;

/**
 * The target of every `[[Target]]` and `[[Target|Label]]`, in reading order, undeduplicated.
 *
 * Airline names come back here too, because the airline is column one of the same table:
 * `[[easyJet]]` and `[[TUI Airways]]` are wikilinks like any other. That is deliberate. The
 * columns are separated by a `|`, which is also what separates a link from its label and a
 * template from its arguments, so telling the two columns apart means parsing the table.
 * The runner does not need it. It keeps only targets that resolve to an airport with an
 * IATA code, and an airline article has never carried one.
 */
export function wikilinkTargets(text) {
	const targets = [];
	for (const match of text.matchAll(WIKILINK)) {
		// `[[East_Midlands Airport#Terminal]]` and `[[East Midlands Airport]]` are the same
		// page, so the runner should be asked about it once and under one name.
		const target = match[1].split('#')[0].replace(/[\s_]+/g, ' ').trim();
		if (target) targets.push(target);
	}
	return targets;
}

/**
 * What the runner calls: raw article wikitext in, the wikilink targets of every passenger
 * destination table out, deduplicated and in first-seen order.
 */
export function destinationTitlesFrom(wikitext) {
	const titles = new Set();
	for (const table of findDestinationTables(wikitext)) {
		for (const target of wikilinkTargets(stripEditorialNoise(table.body))) titles.add(target);
	}
	return [...titles];
}
