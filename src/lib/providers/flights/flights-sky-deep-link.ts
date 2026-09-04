import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../../domain';

/**
 * `FlightOffer.deepLink` (../../domain/flight-offer.ts) is documented as a link to book or
 * view this exact offer, but `search-one-way` prices a whole itinerary without handing back
 * a bookable URL for it — the same gap skyscanner-deep-link.ts documents for Sky Scrapper,
 * and for the same reason: resolving one needs a second, per-itinerary call this adapter's
 * 40-requests-a-month budget cannot spend on every offer shown.
 *
 * This builds Skyscanner's own public search-results URL instead, which this adapter can do
 * honestly rather than as a guess: `flights-sky-types.ts`'s `FlightsSkyEntity` doc comment
 * notes that this API's `auto-complete` returns the exact same numeric entity ids as Sky
 * Scrapper's own `searchAirport` for the same airport (BCN -> "95565085", VIE -> "95673444",
 * both captured for real, see fixtures/flights-sky-auto-complete-*.json vs
 * fixtures/search-airport-*.json) — strong evidence both RapidAPI listings proxy the same
 * underlying Skyscanner inventory, so a Skyscanner search-results link genuinely lands the
 * traveller on this same itinerary's market, not an unrelated one.
 */
export function buildSearchResultsDeepLink(params: {
	origin: IataAirportCode;
	destination: IataAirportCode;
	departureDate: IsoCalendarDate;
	travellers: number;
	currency: IsoCurrencyCode;
}): string {
	const yymmdd = toYyMmDd(params.departureDate);
	const path = [params.origin.toLowerCase(), params.destination.toLowerCase(), yymmdd].join('/');
	const query = new URLSearchParams({
		adultsv2: String(Math.max(1, params.travellers)),
		cabinclass: 'economy',
		currency: params.currency,
		rtn: '0'
	});
	return `https://www.skyscanner.net/transport/flights/${path}/?${query.toString()}`;
}

/** "2026-10-15" -> "261015", the date shape Skyscanner's own search URLs use. */
function toYyMmDd(isoCalendarDate: IsoCalendarDate): string {
	const [year, month, day] = isoCalendarDate.split('-');
	return `${year.slice(2)}${month}${day}`;
}
