import { describe, expect, it } from 'vitest';
import {
	destinationTitlesFrom,
	findDestinationTables,
	stripCitations,
	stripEditorialNoise,
	wikilinkTargets
} from './direct-routes-parser.mjs';

/** Boa Vista's destinations section as the English Wikipedia article
 * `Aristides Pereira International Airport` carried it on 2026-09-05, with three of its
 * eleven airline rows kept whole and the rest dropped. Nothing here is retyped: the
 * `<!-- --->` comments really do have three dashes, and the dashes in `Milan–Malpensa` are
 * en dashes, because both are what the parser has to survive. */
const BOA_VISTA_SECTION = `==Airlines and destinations==
The following airlines operate regular scheduled and charter flights at Aristides Pereira International Airport:
{{Airport-dest-list
<!-- --->
| [[easyJet]] | [[Porto Airport|Porto]]{{cn|date=September 2026}}
<!-- --->
|[[Neos (airline)|Neos]]| [[Milan–Malpensa]],<ref>{{Cite journal|author=<!-- not stated -->|journal=OAG Flight Guide Worldwide|title=Milan|date=November 2023|volume=25|issue=5|publisher=OAG Aviation Worldwide Limited|publication-place=Luton, United Kingdom|issn=1466-8718|language=en|pages=666–673}}</ref> [[Verona Villafranca Airport|Verona]]<ref>{{cite web|url=https://www.neosair.it/OrarioVoli.aspx|title=Timetable|website=neosair.it}}</ref> <br/> '''Seasonal:''' [[Milan Bergamo Airport|Bergamo]]{{cn|date=September 2026}}
<!-- -->
|[[TUI Airways]] | [[Manchester Airport|Manchester]]{{cn|date=September 2026}} <br/> '''Seasonal:''' [[East Midlands Airport|East Midlands]]<ref>{{cite web | url=https://travelweekly.co.uk/news/air/tui-adds-300000-seats-to-summer-2025-programme | title=Tui adds 345,000 seats to summer 2025 programme }}</ref>
<!-- -->
}}

==Statistics==`;

/** East Midlands, both tables, one airline row kept in each. The cargo half is why the
 * heading matters at all. */
const EAST_MIDLANDS_SECTIONS = `==Airlines and destinations==
===Passenger===
{{no footnotes|section|date=January 2025}}
The following airlines operate regular scheduled passenger flights to and from East Midlands:
<!-- WHEN ADDING A NEW ROUTE, OR ADDING AN END DATE FOR A ROUTE PLEASE ADD AN INDEPENDENT REFERENCE, ALSO ADD THE ROUTE AND LINK ON THE CORRESPONDING AIRPORTS ARTICLE AND THE AIRLINES ARTICLE IF IT IS A NEW DESTINATION, ANYTHING WHICH IS NOT REFERENCED WILL BE REMOVED. -->

{{Airport-dest-list
<!-- -->
| {{nowrap|[[TUI Airways]]}} | [[Sharm El Sheikh International Airport|Sharm El Sheikh]] <br/> '''Seasonal:''' [[Aristides Pereira International Airport|Boa Vista]],<ref>{{cite web | url=https://travelweekly.co.uk/news/air/tui-adds-300000-seats-to-summer-2025-programme | title=Tui adds 345,000 seats to summer 2025 programme }}</ref> [[Paphos International Airport|Paphos]],<ref name="Derbyshire Live-2020"/> [[Zakynthos International Airport|Zakynthos]]<ref name="Derbyshire Live-2020"/>
<!-- -->
}}

===Cargo===
{{More citations needed section|date=December 2025}}
<!--DO NOT ADD A DESTINATION CHART WITHOUT VALID SOURCES FOR A RECURRING SCHEDULE. FLIGHTRADAR PAGES ARE NOT CONSIDERED RELIABLE SOURCES-->
{{Airport-dest-list
<!-- -->
| [[Atlas Air]]<ref name="New Cargo">{{cite web | title=East Midlands Airport Welcomes Seven New Cargo Airlines and Boosts Freight Volumes by Nearly 12% | url=https://www.britishaviationgroup.co.uk/knowledge/east-midlands-airport-welcomes-seven-new-cargo-airlines-and-boosts-freight-volumes-by-nearly-12/ }}</ref> | [[Ted Stevens Anchorage International Airport|Anchorage]], [[Frankfurt Airport|Frankfurt]], [[Hangzhou Xiaoshan International Airport|Hangzhou]]
<!-- -->
}}`;

/** Milan Bergamo, two rows either side of the article's broken citations. Each
 * `<ref>{{cite web | url=... | </ref>` opens a template and closes a ref, which is a
 * malformed page Wikipedia serves anyway. This fixture is the reason `stripCitations` runs
 * before anything counts a brace. */
const BERGAMO_TABLE = `==Airlines and destinations==
{{Airport destination list
<!-- -->
| [[Nile Air]] | [[Cairo International Airport|Cairo]]{{cn|date=July 2026}}
<!-- -->
| {{nowrap|[[Norwegian Air Shuttle]]}} | [[Copenhagen Airport|Copenhagen]],<ref>{{cite web | url=https://bergamo.corriere.it/notizie/cronaca/23_novembre_14/voli-da-orio-a-copenaghen-e-non-solo-tre-nuove-rotte-per-la-norvegia-5db8a446-2098-4b1f-8ac9-75076a3b8xlk.shtml | </ref> [[Helsinki Airport|Helsinki]],<ref>{{cite web | url=https://bergamo.corriere.it/notizie/cronaca/23_novembre_14/voli-da-orio-a-copenaghen-e-non-solo-tre-nuove-rotte-per-la-norvegia-5db8a446-2098-4b1f-8ac9-75076a3b8xlk.shtml | </ref> [[Oslo Airport, Gardermoen|Oslo]]{{cn|date=July 2026}} <br/> '''Seasonal:''' [[Bergen Airport, Flesland|Bergen]],{{cn|date=July 2026}} [[Stavanger Airport|Stavanger]]<ref>{{cite web | url=https://www.guidaviaggi.it/2024/01/17/norwegian-air-shuttle-vola-da-bergamo-a-tromso/ | </ref>
<!-- -->
}}

==Statistics==`;

/** Lübeck, whose whole table is two rows and whose template name is lower case. */
const LUBECK_TABLE = `The following airlines operate regular scheduled flights at Lübeck Airport:

{{airport-dest-list
<!-- -->
| [[Corendon Airlines]] | '''Seasonal:''' [[Antalya Airport|Antalya]]<ref>{{Cite web | title=Corendon fliegt im Herbst von Lübeck nach Antalya {{!}} aeroTELEGRAPH | url=https://www.aerotelegraph.com/ticker/corendon-fliegt-im-herbst-von-luebeck-nach-antalya/ms53hrz | access-date=2025-10-04 | website=www.aerotelegraph.com | date=29 January 2025 }}</ref>
<!-- -->
| [[Ryanair]] | [[Stansted Airport|London–Stansted]],<ref name="MalagaRyanair"/> [[Málaga Airport|Málaga]]<ref name="MalagaRyanair"/>
<!-- -->
}}`;

describe('reading a wikilink', () => {
	it('answers the target whether or not the link carries a label', () => {
		expect(wikilinkTargets('[[Milan–Malpensa]] and [[Porto Airport|Porto]]')).toEqual([
			'Milan–Malpensa',
			'Porto Airport'
		]);
	});

	it('answers one title for the several ways wikitext spells it', () => {
		// All four are the same page. The runner asks a resolver about each target it is
		// handed, so a title that differs only in punctuation is a wasted lookup that comes
		// back empty and silently costs the airport a route.
		expect(
			wikilinkTargets('[[East_Midlands Airport]] [[East Midlands Airport#Terminal]] [[ East Midlands Airport ]] [[East Midlands Airport|East Midlands]]')
		).toEqual([
			'East Midlands Airport',
			'East Midlands Airport',
			'East Midlands Airport',
			'East Midlands Airport'
		]);
	});

	it('does not deduplicate, because the caller decides what a repeat means', () => {
		expect(wikilinkTargets('[[Faro Airport|Faro]], [[Faro Airport|Faro]]')).toHaveLength(2);
	});
});

describe('the Boa Vista article', () => {
	it('names East Midlands, which is the whole of issue #361', () => {
		// One line of one Wikipedia article is why the app can propose EMA at all: TUI flies
		// East Midlands to Boa Vista, no aggregator this app can reach says so, and without
		// this table the route does not exist as far as the search is concerned.
		expect(destinationTitlesFrom(BOA_VISTA_SECTION)).toContain('East Midlands Airport');
	});

	it('hands the runner redirect titles exactly as the article writes them', () => {
		// `Milan–Malpensa` is a redirect and `Milan Bergamo Airport` is the article's own
		// current name for a page that has been renamed twice. Normalising either here would
		// be this module guessing at Wikipedia's title history, which is the resolver's job
		// and the resolver has the redirect table.
		const titles = destinationTitlesFrom(BOA_VISTA_SECTION);
		expect(titles).toContain('Milan–Malpensa');
		expect(titles).toContain('Milan Bergamo Airport');
	});

	it('answers airlines and airports together, in the order the table reads', () => {
		expect(destinationTitlesFrom(BOA_VISTA_SECTION)).toEqual([
			'easyJet',
			'Porto Airport',
			'Neos (airline)',
			'Milan–Malpensa',
			'Verona Villafranca Airport',
			'Milan Bergamo Airport',
			'TUI Airways',
			'Manchester Airport',
			'East Midlands Airport'
		]);
	});

	it('stops the table at its own closing braces', () => {
		const [table] = findDestinationTables(BOA_VISTA_SECTION);
		expect(table.heading).toBe('Airlines and destinations');
		expect(table.body.endsWith('}}')).toBe(true);
		expect(table.body).not.toContain('Statistics');
	});
});

describe('cargo tables', () => {
	it('drops the freight table and keeps the passenger one on the same page', () => {
		expect(findDestinationTables(EAST_MIDLANDS_SECTIONS).map((table) => table.heading)).toEqual([
			'Passenger'
		]);
	});

	it('keeps every airport the freight table names out of the answer', () => {
		// Anchorage, Frankfurt and Hangzhou are all airports this app searches, and a
		// traveller cannot board any of these flights. A cargo row read as a passenger row is
		// an itinerary the app offers and nobody can buy.
		const titles = destinationTitlesFrom(EAST_MIDLANDS_SECTIONS);
		expect(titles).toContain('Aristides Pereira International Airport');
		expect(titles).toContain('Paphos International Airport');
		expect(titles).not.toContain('Ted Stevens Anchorage International Airport');
		expect(titles).not.toContain('Hangzhou Xiaoshan International Airport');
	});
});

describe('the template name the article happens to use', () => {
	it('reads all three spellings in live use', () => {
		expect(findDestinationTables(BOA_VISTA_SECTION)).toHaveLength(1);
		expect(findDestinationTables(BERGAMO_TABLE)).toHaveLength(1);
		expect(findDestinationTables(LUBECK_TABLE)).toHaveLength(1);
	});

	it('answers nothing for an article with no destination table', () => {
		expect(destinationTitlesFrom('==History==\nA field with [[Grass|grass]] on it.')).toEqual([]);
	});
});

describe('Milan Bergamo, and the order of the two steps', () => {
	it('reads the table through the broken citations in it', () => {
		const titles = destinationTitlesFrom(BERGAMO_TABLE);
		expect(titles).toContain('Cairo International Airport');
		expect(titles).toContain('Oslo Airport, Gardermoen');
		expect(titles).toContain('Stavanger Airport');
	});

	it('finds nothing at all if the braces are counted first', () => {
		// The regression guard for the ordering, not for the answer. Three
		// `{{cite web ... | </ref>` on this page open a template that never closes, so a
		// brace match run over the raw article never reaches depth zero again and the table
		// has no end. BGY, OSL and SNN each contributed zero routes until `stripCitations`
		// was moved in front, and BGY is the airport issue #340 is about.
		expect(bracesFirstTargets(BERGAMO_TABLE)).toEqual([]);
		expect(bracesFirstTargets(stripCitations(BERGAMO_TABLE))).toContain(
			'Oslo Airport, Gardermoen'
		);
	});
});

describe('editorial noise around a destination', () => {
	it('drops a seasonal label and keeps the airport it labels', () => {
		const row = stripEditorialNoise(
			`| [[Corendon Airlines]] | '''Seasonal:''' [[Antalya Airport|Antalya]]`
		);
		expect(row).not.toContain('Seasonal');
		expect(wikilinkTargets(row)).toEqual(['Corendon Airlines', 'Antalya Airport']);
	});

	it('keeps a destination that is written in bold', () => {
		// The Bram Fischer row, verbatim. All 207 bold runs of this shape in the corpus are
		// outside a destination table today, so this changes no current route. It is here
		// because a blanket `'''...'''` strip is one edit away, and that edit deletes an
		// airport instead of a label.
		const row = stripEditorialNoise(
			`'''<small>[[Bram Fischer International Airport|Bloemfontein]]</small>''' '''Seasonal:'''`
		);
		expect(row).not.toContain('Seasonal');
		expect(wikilinkTargets(row)).toEqual(['Bram Fischer International Airport']);
	});

	it('drops a citation-needed tag, a line break and a start date', () => {
		// The start date goes because this table only claims a route exists.
		// `src/lib/algorithm/connections.ts` prices every proposal against a live provider
		// anyway, so a route recorded here and not yet flying costs one empty search, and a
		// route dropped here is one the app can never offer.
		const row = stripEditorialNoise(
			`| [[American Airlines]] | [[John F. Kennedy International Airport|New York–JFK]] (begins 29 March 2027),{{cn|date=September 2026}} <br/> [[Amílcar Cabral International Airport|Sal]] (ends 22 October 2026)`
		);
		expect(row).not.toMatch(/begins|ends|cn\||<br/i);
		expect(wikilinkTargets(row)).toEqual([
			'American Airlines',
			'John F. Kennedy International Airport',
			'Amílcar Cabral International Airport'
		]);
	});
});

describe('stripCitations', () => {
	it('removes a self-closing ref before a paired one can swallow the gap', () => {
		// The pairing bug this ordering prevents: `<ref[^>]*>` matches the opening of
		// `<ref name="x"/>` too, so a paired strip that started there would run on to the
		// next `</ref>` and delete Málaga along the way.
		expect(stripCitations(LUBECK_TABLE)).toContain('[[Málaga Airport|Málaga]]');
	});

	it('leaves a malformed table body with braces that balance', () => {
		expect(balance(BERGAMO_TABLE)).toBeGreaterThan(0);
		expect(balance(stripCitations(BERGAMO_TABLE))).toBe(0);
	});

	it('removes the three-dash comments this corpus is full of', () => {
		expect(stripCitations(BOA_VISTA_SECTION)).not.toContain('<!--');
	});
});

/** `{{` seen minus `}}` seen. Anything above zero is a page a brace matcher cannot finish. */
function balance(text) {
	return (text.match(/\{\{/g) ?? []).length - (text.match(/\}\}/g) ?? []).length;
}

/** What "simplify this" looks like when someone reorders the two steps: find the template,
 * match its braces on the raw article, strip the citations out of whatever came back. Here
 * to fail. */
function bracesFirstTargets(wikitext) {
	const start = wikitext.search(/\{\{\s*airport[ _-]dest(?:ination)?[ _-]list\b/i);
	let depth = 0;
	for (let i = start; i < wikitext.length - 1; i += 1) {
		if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
			depth += 1;
			i += 1;
		} else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
			depth -= 1;
			i += 1;
			if (depth === 0) return wikilinkTargets(stripCitations(wikitext.slice(start, i + 1)));
		}
	}
	return [];
}
