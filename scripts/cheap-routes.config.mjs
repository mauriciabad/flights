// Issue #52: origins to fetch nightly Travelpayouts cheap-route data for. A plain
// array in its own file so extending the list (e.g. adding a second home airport)
// never means touching scripts/fetch-cheap-routes.mjs itself.
//
// Start with the owner's home airport (docs/PROVIDERS.md / issue #52: "Start with
// BCN"). IATA codes, uppercase.
export const ORIGINS = ['BCN'];
