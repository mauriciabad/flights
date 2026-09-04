// Issue #52: origins to fetch nightly Travelpayouts cheap-route data for. A plain
// array in its own file so extending the list (e.g. adding a second home airport)
// never means touching scripts/fetch-cheap-routes.mjs itself.
//
// Expanded from just BCN after a real session failed on BVC (Boa Vista, Cabo Verde):
// Ryanair does not serve Cabo Verde, and this dataset was the only other free source,
// so the app knew nothing about the route at all. The Travelpayouts Data API is free
// and allows 300 requests per minute, and this runs once nightly in CI, so breadth here
// costs nothing at runtime and is the cheapest coverage the app can buy. IATA codes,
// uppercase.
export const ORIGINS = [
	// Spain / the owner's home region
	'BCN', 'MAD', 'AGP', 'VLC', 'SVQ', 'BIO', 'PMI', 'ALC',
	// Places he has actually searched for, and their neighbours
	'BVC', 'SID', 'RAI', 'LIS', 'OPO', 'FNC', 'LPA', 'TFS',
	// Major European hubs, which are the usual stopover cities
	'LGW', 'LHR', 'STN', 'CDG', 'ORY', 'AMS', 'BRU', 'CRL',
	'FRA', 'BER', 'MUC', 'VIE', 'ZRH', 'MXP', 'BGY', 'FCO',
	'DUB', 'CPH', 'ARN', 'HEL', 'WAW', 'KRK', 'BUD', 'PRG',
	'ATH', 'IST', 'OTP', 'SOF', 'RIX', 'VNO', 'TLL'
];
