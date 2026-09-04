import { describe, expect, it } from 'vitest';
import { primaryCityName, resolveAirportCityLabel } from './airport-city';

describe('primaryCityName', () => {
	it('passes through a plain name unchanged', () => {
		expect(primaryCityName('Vienna')).toBe('Vienna');
	});

	it('takes the segment before a "City, Region" comma', () => {
		expect(primaryCityName('Birmingham, West Midlands')).toBe('Birmingham');
		expect(primaryCityName('London, Essex')).toBe('London');
	});

	it('collapses a duplicated "City, City" pair (OurAirports data for LTN)', () => {
		expect(primaryCityName('Luton, Luton')).toBe('Luton');
	});

	it('strips a parenthetical qualifier', () => {
		expect(primaryCityName('Orio al Serio (BG)')).toBe('Orio al Serio');
		expect(primaryCityName('Ferno (VA)')).toBe('Ferno');
	});

	it('strips the parenthetical before splitting on comma, not after — CDG has a comma INSIDE its parenthetical', () => {
		// Splitting on comma first would cut this to "Paris (Roissy-en-France", which is not
		// a name Agoda's free-text search should ever see.
		expect(primaryCityName("Paris (Roissy-en-France, Val-d'Oise)")).toBe('Paris');
	});
});

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

	it('does NOT resolve BGY (Bergamo/Milan) or MXP (Malpensa/Milan) to Milan — a known, documented gap', async () => {
		// OurAirports' own municipality field names the literal small comune each airport
		// sits in ("Orio al Serio", "Ferno"), never Milan, and Transitous's admin trail
		// doesn't reach "Milano" from either coordinate at any level either (see this file's
		// header) — there is no signal this function could read to produce "Milan" without a
		// hand-curated table, which is out of scope for this fix. Asserted here so a future
		// change to this heuristic gets caught if it silently starts guessing.
		const bgy = await resolveAirportCityLabel({ latitude: 45.669362, longitude: 9.708851 });
		const mxp = await resolveAirportCityLabel({ latitude: 45.6306, longitude: 8.72811 });
		expect(bgy).toBe('Orio al Serio, Italy');
		expect(mxp).toBe('Ferno, Italy');
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
