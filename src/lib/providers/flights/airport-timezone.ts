import type { LocalDateTime } from '../../domain';
import type { GeocodeProviderOptions } from '../geocode/transitous';
import { lookupAirportTimeZone } from '../geocode/transitous';
import type { ProviderContext } from '../types';

/**
 * Neither Sky Scrapper's nor Flights Sky's flight search ever sends a time zone or a UTC
 * offset. `departure` and `arrival` are bare local wall-clock strings like
 * "2026-10-15T08:05:00" (confirmed against real responses captured for issues #5 and #61 —
 * fixtures/search-flights-bcn-vie.json and fixtures/flights-sky-search-one-way-bcn-vie.json).
 * AGENTS.md is explicit that collapsing a local time to UTC without the offset is how an
 * overnight connection silently loses a night, so this file exists to attach the offset
 * neither API will give us, using the one fact we do have: which airport the time belongs to.
 *
 * Issue #124: this used to be two near-identical files, `skyscanner-timezone.ts` and
 * `flights-sky-timezone.ts`, built for separate issues that landed in whichever order they
 * landed in. That was exactly why one of them (this one, issue #75) got the live Transitous
 * fallback below and the other quietly kept a static ~100-airport table as its entire answer —
 * confirmed live on BVC (Boa Vista, Cape Verde): Flights Sky's own `search-one-way` returned a
 * real, nonstop, bookable TUI flight to London Gatwick, and the old flights-sky-timezone.ts
 * dropped it, and every other itinerary on the route, because BVC was never in its table.
 * Unifying into one module is the actual fix, not a second copy of the fallback — a future
 * third adapter gets this for free instead of a third chance to silently regress.
 *
 * `resolveAirportTimeZone` below is the live path — issue #64's `lookupAirportTimeZone`,
 * which reverse-geocodes the airport's own OurAirports coordinates through Transitous rather
 * than trusting a list someone typed by hand.
 *
 * SEED_TIME_ZONES survives, but demoted from "the whole answer" to "the fast, offline-safe
 * first guess for the busiest routes." Two reasons, both found while building the original
 * split version of this file:
 *
 * 1. Transitous is free, volunteer-run, and will be down or slow sometimes (docs/PROVIDERS.md,
 *    AGENTS.md "When the data is missing"). A network round trip on every airport this app has
 *    seen a thousand times before is a needless dependency for something that almost never
 *    changes.
 * 2. Transitous's own coverage has real gaps, including for major airports. A live check
 *    against the reverse-geocode endpoint on the day this was built returned an EMPTY result
 *    for DXB — Dubai International, one of the busiest airports on Earth, and one of the 16
 *    issue #64 itself verified against — even though it had answered correctly for the same
 *    airport before. Whether that is a transient gap or a real coverage hole does not matter
 *    for a shipped adapter: either way, a seed value for a hub this busy is worth keeping so a
 *    Transitous outage does not quietly take down every Dubai search.
 *
 * So the order is seed table first (no network, cannot be stale in any way that matters — a
 * time zone assignment changes when a country changes its clocks, which is rare and
 * newsworthy), live Transitous lookup second for everything the seed does not cover. Either
 * path, or an outright lookup failure with nothing cached, resolves to `undefined` rather than
 * a guess — never a guess, per AGENTS.md, but callers should not let it stay a silent one
 * either. `skyscanner-map-offers.ts` drops an offer it cannot time; `flights-sky.ts` goes
 * further and records how many real, otherwise-mappable itineraries got dropped this way, so a
 * provider that answered with real inventory nobody could time is distinguishable, on the
 * results screen, from one that genuinely had nothing (issue #130/#144's provider-answer
 * machinery).
 */

// prettier-ignore
const SEED_TIME_ZONES: Readonly<Record<string, string>> = {
	// Spain, Portugal, France
	MAD: 'Europe/Madrid', BCN: 'Europe/Madrid', VLC: 'Europe/Madrid', SVQ: 'Europe/Madrid',
	AGP: 'Europe/Madrid', BIO: 'Europe/Madrid', ALC: 'Europe/Madrid', IBZ: 'Europe/Madrid',
	PMI: 'Europe/Madrid', LPA: 'Atlantic/Canary', TFS: 'Atlantic/Canary', TFN: 'Atlantic/Canary',
	FUE: 'Atlantic/Canary', ACE: 'Atlantic/Canary', LIS: 'Europe/Lisbon', OPO: 'Europe/Lisbon',
	FAO: 'Europe/Lisbon', PDL: 'Atlantic/Azores', CDG: 'Europe/Paris', ORY: 'Europe/Paris',
	NCE: 'Europe/Paris', MRS: 'Europe/Paris', LYS: 'Europe/Paris', TLS: 'Europe/Paris',
	BOD: 'Europe/Paris', NTE: 'Europe/Paris',

	// UK, Ireland, Benelux
	LHR: 'Europe/London', LGW: 'Europe/London', STN: 'Europe/London', LTN: 'Europe/London',
	LCY: 'Europe/London', MAN: 'Europe/London', EDI: 'Europe/London', GLA: 'Europe/London',
	BHX: 'Europe/London', BRS: 'Europe/London', DUB: 'Europe/Dublin', ORK: 'Europe/Dublin',
	AMS: 'Europe/Amsterdam', BRU: 'Europe/Brussels', CRL: 'Europe/Brussels', LUX: 'Europe/Luxembourg',

	// Germany, Switzerland, Austria
	FRA: 'Europe/Berlin', MUC: 'Europe/Berlin', BER: 'Europe/Berlin', HAM: 'Europe/Berlin',
	DUS: 'Europe/Berlin', CGN: 'Europe/Berlin', STR: 'Europe/Berlin', NUE: 'Europe/Berlin',
	ZRH: 'Europe/Zurich', GVA: 'Europe/Zurich', BSL: 'Europe/Zurich', VIE: 'Europe/Vienna',
	SZG: 'Europe/Vienna', INN: 'Europe/Vienna',

	// Italy, Greece, Balkans
	FCO: 'Europe/Rome', MXP: 'Europe/Rome', LIN: 'Europe/Rome', VCE: 'Europe/Rome',
	NAP: 'Europe/Rome', BLQ: 'Europe/Rome', CTA: 'Europe/Rome', PMO: 'Europe/Rome',
	ATH: 'Europe/Athens', SKG: 'Europe/Athens', HER: 'Europe/Athens', ZAG: 'Europe/Zagreb',
	SPU: 'Europe/Zagreb', DBV: 'Europe/Zagreb', LJU: 'Europe/Ljubljana', BEG: 'Europe/Belgrade',
	SJJ: 'Europe/Sarajevo', SKP: 'Europe/Skopje', TIA: 'Europe/Tirane', OTP: 'Europe/Bucharest',
	SOF: 'Europe/Sofia',

	// Nordics and Baltics
	CPH: 'Europe/Copenhagen', ARN: 'Europe/Stockholm', GOT: 'Europe/Stockholm',
	OSL: 'Europe/Oslo', BGO: 'Europe/Oslo', HEL: 'Europe/Helsinki', KEF: 'Atlantic/Reykjavik',
	RIX: 'Europe/Riga', TLL: 'Europe/Tallinn', VNO: 'Europe/Vilnius',

	// Central and Eastern Europe
	WAW: 'Europe/Warsaw', KRK: 'Europe/Warsaw', GDN: 'Europe/Warsaw', PRG: 'Europe/Prague',
	BUD: 'Europe/Budapest', BTS: 'Europe/Bratislava',

	// Turkey, Middle East, North Africa
	IST: 'Europe/Istanbul', SAW: 'Europe/Istanbul', TLV: 'Asia/Jerusalem', AMM: 'Asia/Amman',
	BEY: 'Asia/Beirut', DXB: 'Asia/Dubai', AUH: 'Asia/Dubai', DOH: 'Asia/Qatar',
	RUH: 'Asia/Riyadh', JED: 'Asia/Riyadh', CAI: 'Africa/Cairo', CMN: 'Africa/Casablanca',
	TUN: 'Africa/Tunis', ALG: 'Africa/Algiers',

	// Asia-Pacific
	NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo', ICN: 'Asia/Seoul', PEK: 'Asia/Shanghai',
	PVG: 'Asia/Shanghai', HKG: 'Asia/Hong_Kong', TPE: 'Asia/Taipei', SIN: 'Asia/Singapore',
	BKK: 'Asia/Bangkok', KUL: 'Asia/Kuala_Lumpur', CGK: 'Asia/Jakarta', MNL: 'Asia/Manila',
	DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata', MLE: 'Indian/Maldives', SYD: 'Australia/Sydney',
	MEL: 'Australia/Melbourne', BNE: 'Australia/Brisbane', PER: 'Australia/Perth',
	AKL: 'Pacific/Auckland',

	// Africa (sub-Saharan)
	JNB: 'Africa/Johannesburg', CPT: 'Africa/Johannesburg', NBO: 'Africa/Nairobi',
	LOS: 'Africa/Lagos', ACC: 'Africa/Accra',

	// North America
	JFK: 'America/New_York', EWR: 'America/New_York', LGA: 'America/New_York',
	BOS: 'America/New_York', ATL: 'America/New_York', MIA: 'America/New_York',
	ORD: 'America/Chicago', DFW: 'America/Chicago', IAH: 'America/Chicago',
	DEN: 'America/Denver', PHX: 'America/Phoenix', LAX: 'America/Los_Angeles',
	SFO: 'America/Los_Angeles', SEA: 'America/Los_Angeles', LAS: 'America/Los_Angeles',
	YYZ: 'America/Toronto', YUL: 'America/Toronto', YVR: 'America/Vancouver',
	MEX: 'America/Mexico_City',

	// South America
	GRU: 'America/Sao_Paulo', GIG: 'America/Sao_Paulo', EZE: 'America/Argentina/Buenos_Aires',
	SCL: 'America/Santiago', BOG: 'America/Bogota', LIM: 'America/Lima'
};

/**
 * The offline-safe fast path: `undefined` for anything outside this short, deliberately
 * non-exhaustive list of busy hubs (see this file's header for why a seed still exists at
 * all). Callers needing an honest "do we actually know this airport's zone" answer should
 * call `resolveAirportTimeZone` below instead, which falls through to a live lookup rather
 * than treating a seed miss as a final answer.
 */
export function seedTimeZoneForAirport(iataCode: string): string | undefined {
	return SEED_TIME_ZONES[iataCode.toUpperCase()];
}

/**
 * The one place skyscanner.ts should ever need to reach for an airport's time zone. Seed
 * table first (no network, cannot be stale), then issue #64's live Transitous lookup — which
 * already caches a resolved zone for 90 days (geocode/transitous.ts `LONG_CACHE_TTL_MS`), so
 * a cold-seed airport only ever pays the network cost once per its cache window, not once per
 * search.
 *
 * Resolves `undefined`, never a guess, when neither path knows this airport's zone: a
 * genuine dataset gap (`lookupAirportTimeZone` found no OurAirports coordinates for this
 * code), a Transitous outage, or a live lookup with an empty result — DXB, one of this app's
 * own seeded hubs, returned an empty Transitous response on the day this was built despite
 * issue #64 having verified it correctly before, which is exactly the kind of live gap the
 * seed table exists to paper over for busy routes and this function still has no way to paper
 * over for anything outside it. `skyscanner-map-offers.ts` treats `undefined` as "drop this
 * offer," never as "assume UTC" — AGENTS.md: "say what you do not know rather than guessing."
 */
export async function resolveAirportTimeZone(
	iataCode: string,
	ctx: ProviderContext,
	options: GeocodeProviderOptions = {}
): Promise<string | undefined> {
	const seeded = seedTimeZoneForAirport(iataCode);
	if (seeded !== undefined) return seeded;

	const result = await lookupAirportTimeZone(iataCode, ctx, options);
	return result.ok ? result.data : undefined;
}

/**
 * Builds a domain `LocalDateTime` from a bare local wall-clock string and an already-resolved
 * IANA zone. Takes the zone directly, not an airport code, because resolving one needs a
 * network round trip in the worst case (`resolveAirportTimeZone` above) and this function's
 * only job is the pure arithmetic of attaching the right offset once that zone is known.
 */
export function buildLocalDateTime(localIso: string, timeZone: string): LocalDateTime {
	return { local: localIso, timeZone, utcOffsetMinutes: utcOffsetMinutesAt(localIso, timeZone) };
}

/**
 * Builds a domain `LocalDateTime` for `iataCode` by looking its zone up in `timeZones`
 * (every code this response's offers can reference, pre-resolved once per `searchOffers`
 * call — see skyscanner.ts), or `undefined` if that airport's zone could not be resolved.
 * This is the one place skyscanner-map-offers.ts should ever need to reach for a time zone;
 * that keeps the "what happens when we do not know the zone" decision (drop the offer, do
 * not guess) in one function instead of repeated at every call site.
 */
export function toLocalDateTime(
	localIso: string,
	iataCode: string,
	timeZones: ReadonlyMap<string, string>
): LocalDateTime | undefined {
	const timeZone = timeZones.get(iataCode.toUpperCase());
	if (timeZone === undefined) return undefined;
	return buildLocalDateTime(localIso, timeZone);
}

/**
 * The UTC offset, in minutes, that `timeZone` observes at the wall-clock moment described by
 * `localIso` (a "2026-10-15T08:05:00"-shaped string with no zone suffix), not at "now" and
 * not a fixed per-zone constant, because the same IANA zone carries two different offsets
 * across a year (Europe/Madrid is +60 in January and +120 in July) and this adapter has no
 * way to know in advance which side of a DST change a given flight falls on.
 *
 * This is the standard two-pass technique for reading an `Intl` zone backwards (wall-clock
 * time to offset), since the built-in direction only goes the other way (instant to
 * wall-clock time).
 *
 * 1. Treat the local string as if it were already a UTC instant. That guess is wrong by
 *    exactly the offset this function is trying to find.
 * 2. Ask what offset the zone has at the guessed instant, and shift the guess by it to get a
 *    candidate real instant.
 * 3. Re-check the offset at that candidate. On the rare date where it disagrees with step 2
 *    because the guess crossed a DST boundary, the candidate's own offset is the correct
 *    answer. Two passes cover every case except the one or two hours a year a local clock
 *    reading is genuinely ambiguous (the "fall back" hour) or does not exist at all (the
 *    "spring forward" hour), which this function does not try to resolve: no flight is
 *    scheduled to depart during a gap that, on the ground, never happens.
 */
export function utcOffsetMinutesAt(localIso: string, timeZone: string): number {
	const guessInstant = new Date(`${localIso}Z`);
	const firstOffset = offsetAtInstant(guessInstant, timeZone);
	const candidateInstant = new Date(guessInstant.getTime() - firstOffset * 60_000);
	return offsetAtInstant(candidateInstant, timeZone);
}

/** The UTC offset, in minutes, `timeZone` observes at a real instant. This is the direction
 * `Intl` actually supports, and the building block for the wall-clock-to-offset function
 * above. */
function offsetAtInstant(instant: Date, timeZone: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const parts: Record<string, string> = {};
	for (const part of formatter.formatToParts(instant)) {
		if (part.type !== 'literal') parts[part.type] = part.value;
	}
	// Hour 24 shows up from some engines for midnight under h23; normalise it to 0.
	const hour = parts.hour === '24' ? '00' : parts.hour;
	const asIfUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(hour),
		Number(parts.minute),
		Number(parts.second)
	);
	return Math.round((asIfUtc - instant.getTime()) / 60_000);
}
