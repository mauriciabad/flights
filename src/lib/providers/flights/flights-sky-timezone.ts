import type { LocalDateTime } from '../../domain';

/**
 * `search-one-way` never sends a time zone or a UTC offset — confirmed against the real
 * fixture captured for this issue (fixtures/flights-sky-search-one-way-bcn-vie.json):
 * `"departure": "2026-09-19T08:10:00"`, no zone suffix, same bare-local-string shape
 * skyscanner-timezone.ts documents for Sky Scrapper. AGENTS.md is explicit that collapsing a
 * local time to UTC without the offset is how an overnight connection silently loses a
 * night, so this file exists to attach the offset the API will not give us, using the one
 * fact we do have: which airport the time belongs to.
 *
 * This table is a near-duplicate of skyscanner-timezone.ts's, not an import from it: the two
 * adapters were built for separate issues that may land in either order, and AGENTS.md asks
 * an agent not to invent a competing shared module for something another issue does not yet
 * own. Once issue #11's real airport-timezone dataset lands, both curated tables should be
 * deleted in favour of it — see skyscanner-timezone.ts's header comment, which says the same
 * thing about its own copy.
 *
 * When an airport is missing from this table, `toLocalDateTime` returns `undefined` and
 * callers (flights-sky-map-offers.ts) drop that offer rather than fabricate an offset.
 */

// prettier-ignore
const IATA_TIME_ZONES: Readonly<Record<string, string>> = {
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

/** `undefined` when this airport is not in the curated table above. */
export function timeZoneForAirport(iataCode: string): string | undefined {
	return IATA_TIME_ZONES[iataCode.toUpperCase()];
}

/**
 * Builds a domain `LocalDateTime` from a bare local wall-clock string and the airport it
 * belongs to, or `undefined` when that airport's time zone is not in the curated table. This
 * is the one place flights-sky-map-offers.ts should ever need to reach for a time zone.
 */
export function toLocalDateTime(localIso: string, iataCode: string): LocalDateTime | undefined {
	const timeZone = timeZoneForAirport(iataCode);
	if (timeZone === undefined) return undefined;
	return { local: localIso, timeZone, utcOffsetMinutes: utcOffsetMinutesAt(localIso, timeZone) };
}

/**
 * The UTC offset, in minutes, `timeZone` observes at the wall-clock moment described by
 * `localIso` — not at "now" and not a fixed per-zone constant, since the same IANA zone
 * carries two different offsets across a year (Europe/Madrid is +60 in January, +120 in
 * July) and this adapter has no way to know in advance which side of a DST change a given
 * flight falls on.
 *
 * Standard two-pass technique for reading an `Intl` zone backwards (wall-clock time to
 * offset), since the built-in direction only goes the other way (instant to wall-clock
 * time):
 *
 * 1. Treat the local string as if it were already a UTC instant. That guess is wrong by
 *    exactly the offset this function is trying to find.
 * 2. Ask what offset the zone has at the guessed instant, and shift the guess by it to get a
 *    candidate real instant.
 * 3. Re-check the offset at that candidate; on the rare date where it disagrees with step 2
 *    because the guess crossed a DST boundary, the candidate's own offset is the correct
 *    answer. This does not try to resolve the one or two hours a year a local clock reading
 *    is genuinely ambiguous or does not exist at all, since no flight is scheduled to depart
 *    during a gap that, on the ground, never happens.
 */
export function utcOffsetMinutesAt(localIso: string, timeZone: string): number {
	const guessInstant = new Date(`${localIso}Z`);
	const firstOffset = offsetAtInstant(guessInstant, timeZone);
	const candidateInstant = new Date(guessInstant.getTime() - firstOffset * 60_000);
	return offsetAtInstant(candidateInstant, timeZone);
}

/** The UTC offset, in minutes, `timeZone` observes at a real instant — the direction `Intl`
 * actually supports, and the building block for the wall-clock-to-offset function above. */
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
