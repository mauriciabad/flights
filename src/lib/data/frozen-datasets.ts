/**
 * The data this app ships with, and the day each piece last came in.
 *
 * The repository was archived in September 2026. GitHub Actions does not run on an
 * archived repo, so the scheduled jobs that refreshed these files never fire again and
 * every date below is final. `ArchivedNotice.svelte` reads this list, so the screen and
 * the data cannot drift apart the way a hand-written paragraph would.
 *
 * ## What is deliberately absent
 *
 * Live provider calls. Fares, beds and timetables still go from the browser straight to
 * Skyscanner, Ryanair, Agoda, Transitous and OSRM on every search, so they are exactly as
 * current as the provider is; nothing about archiving touched them. Only the committed
 * files froze, and mixing the two lists would tell the reader the app is more broken than
 * it is.
 *
 * ## Where each date comes from
 *
 * The four cron-refreshed sets carry their own `fetchedAt` and `frozen-datasets.test.ts`
 * checks these dates against it, because a transcribed figure is a figure that can be
 * wrong. The rest were rebuilt by hand from a script, so their date is the day their
 * generated file was last committed, read with
 * `git log -1 --format=%cs -- src/lib/data/<file>`.
 */

export interface FrozenDataset {
	/** What to call it on screen. */
	readonly name: string;
	/** What it decides inside the app, in one line, so a reader can judge what going stale
	 * costs them rather than being handed a filename. */
	readonly feeds: string;
	/** Who it came from. */
	readonly source: string;
	/** The day the last copy was taken, `YYYY-MM-DD`. */
	readonly fetchedOn: string;
}

/** Freshest first: the two nightly sets, then the weekly ones, then the hand-built data. */
export const FROZEN_DATASETS: readonly FrozenDataset[] = [
	{
		name: 'Exchange rates',
		feeds: 'converting a taxi or bus estimate into the currency you picked',
		source: 'European Central Bank',
		fetchedOn: '2026-09-09'
	},
	{
		name: 'Cheap fares',
		feeds: 'the cheap flights the search starts from before it asks a provider',
		source: 'Ryanair',
		fetchedOn: '2026-09-09'
	},
	{
		name: 'Direct routes',
		feeds: 'knowing which cities have no direct flight, which is what a layover trip is for',
		source: 'Wikipedia',
		fetchedOn: '2026-09-07'
	},
	{
		name: 'Ryanair network',
		feeds: 'which airports Ryanair is asked about without a key',
		source: 'Ryanair',
		fetchedOn: '2026-09-07'
	},
	{
		name: 'Map outlines',
		feeds: 'the coastlines and borders drawn behind every route',
		source: 'Natural Earth',
		fetchedOn: '2026-09-05'
	},
	{
		name: 'City centres',
		feeds: 'where a transfer to town is measured to',
		source: 'GeoNames',
		fetchedOn: '2026-09-05'
	},
	{
		name: 'Airport terminals',
		feeds: 'starting a ground transfer at the terminal door instead of the runway',
		source: 'OpenStreetMap',
		fetchedOn: '2026-09-05'
	},
	{
		name: 'Airports',
		feeds: 'every airport code, name and position the search can offer you',
		source: 'OurAirports',
		fetchedOn: '2026-09-04'
	}
];

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

/**
 * "7 September 2026" from "2026-09-07".
 *
 * Split off the string rather than parsed into a `Date`, and named from a fixed table
 * rather than `Intl.DateTimeFormat`, for two reasons. The first is `format.ts`'s: ICU data
 * differs between whatever Node builds this and whatever browser renders it, and Node's
 * `en-GB` writes September as "Sept". The second is that these pages are prerendered, so
 * the build writes this string into the HTML and hydration compares it to what the browser
 * computes; a formatter that can disagree with itself across two runtimes would produce a
 * mismatch warning for nothing.
 */
export function formatFrozenDate(isoDate: string): string {
	const [year, month, day] = isoDate.split('-');
	const name = MONTH_NAMES[Number(month) - 1];
	if (!year || !name || !day) return isoDate;
	return `${Number(day)} ${name} ${year}`;
}
