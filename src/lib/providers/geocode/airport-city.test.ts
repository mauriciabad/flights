import { describe, expect, it } from 'vitest';
import { resolveAirportCityLabel } from './airport-city';

// The "strip the parenthetical, then the region suffix" rule this file used to own moved
// to `$lib/data/airport-city-names.ts` (issue #136), and is tested there. It runs once, on
// the way into `Airport.city.name`, so the label sent to Agoda and the name printed on the
// result card are now the same string by construction.

describe('resolveAirportCityLabel', () => {
	// Coordinates and city fields below are copied from data/airports.generated.json (issue
	// #11's OurAirports dataset), not values this test invents — same convention
	// transitous.test.ts uses for lookupAirportTimeZone.

	it('resolves VIE (Vienna International Airport) to Vienna, not Fischamend — the exact case issue #65 was filed over', async () => {
		const label = await resolveAirportCityLabel({ latitude: 48.110298, longitude: 16.5697 });
		expect(label).toBe('Vienna, Austria');
	});

	it('resolves CIA (Ciampino) to Rome — OurAirports already carries the served city, not the comune', async () => {
		const label = await resolveAirportCityLabel({ latitude: 41.798769, longitude: 12.595331 });
		expect(label).toBe('Rome, Italy');
	});

	it('resolves CRL (Brussels South Charleroi) to Charleroi, its real host city', async () => {
		const label = await resolveAirportCityLabel({ latitude: 50.461963, longitude: 4.459562 });
		expect(label).toBe('Charleroi, Belgium');
	});

	it('resolves GRO (Girona-Costa Brava) to Girona', async () => {
		const label = await resolveAirportCityLabel({ latitude: 41.904639, longitude: 2.761774 });
		expect(label).toBe('Girona, Spain');
	});

	it('resolves LTN (London Luton) to Luton, collapsing OurAirports’ "Luton, Luton" duplicate', async () => {
		const label = await resolveAirportCityLabel({ latitude: 51.874699, longitude: -0.368333 });
		expect(label).toBe('Luton, United Kingdom');
	});

	it('resolves BGY and MXP to the cities they serve, the gap this test used to pin open', async () => {
		// This assertion used to read 'Orio al Serio, Italy' / 'Ferno, Italy', with a comment
		// saying the fix needed a hand-curated table that was out of scope. Issue #136 built
		// that table (`$lib/data/airport-city-names.ts`), so a stay search anchored on either
		// airport now looks for beds in a city a traveller would spend an evening in rather
		// than in a village beside the runway.
		const bgy = await resolveAirportCityLabel({ latitude: 45.669362, longitude: 9.708851 });
		const mxp = await resolveAirportCityLabel({ latitude: 45.6306, longitude: 8.72811 });
		expect(bgy).toBe('Bergamo, Italy');
		expect(mxp).toBe('Milan, Italy');
	});

	it('returns undefined for a coordinate that matches no known airport', async () => {
		// The middle of the Pacific — nowhere near any scheduled-service airport in this
		// app's dataset.
		const label = await resolveAirportCityLabel({ latitude: 0, longitude: -160 });
		expect(label).toBeUndefined();
	});

	it('tolerates float noise in the coordinate without matching the wrong airport', async () => {
		const label = await resolveAirportCityLabel({ latitude: 48.11029801, longitude: 16.56970002 });
		expect(label).toBe('Vienna, Austria');
	});
});
