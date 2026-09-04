import type { IataAirportCode, IsoCalendarDate, IsoCurrencyCode } from '../../domain';

/**
 * FlightOffer.deepLink is documented as "link to book or view this exact offer" (brief line
 * 62: "keep the deep link so the user can actually book"), but Sky Scrapper's search
 * endpoint prices a whole itinerary without handing back a bookable URL for it. Resolving
 * one needs a second, per-itinerary call (Skyscanner's `getFlightDetails`/polling flow),
 * and this adapter cannot afford that: at 20 requests a month, spending one per offer shown
 * would exhaust the whole budget on a single search's results page.
 *
 * So this builds Skyscanner's own public search-results URL for the route and date instead.
 * It is not a link to this exact fare, but a link that lands the traveller on Skyscanner
 * looking at this exact route and date, where the offer this adapter showed them is one of
 * the results. That is the tradeoff issue #5 makes deliberately: an honest "search again
 * here" link over either an expensive exact deep link or no link at all.
 */
export function buildSearchResultsDeepLink(params: {
	origin: IataAirportCode;
	destination: IataAirportCode;
	departureDate: IsoCalendarDate;
	travellers: number;
	currency: IsoCurrencyCode;
}): string {
	const yymmdd = toYyMmDd(params.departureDate);
	const path = [
		params.origin.toLowerCase(),
		params.destination.toLowerCase(),
		yymmdd
	].join('/');
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
