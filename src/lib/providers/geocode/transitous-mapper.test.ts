import { describe, expect, it } from 'vitest';
import { mapGeocodeResponseToCandidates } from './transitous-mapper';
import type { TransitousGeocodeResponse } from './transitous-types';

describe('mapGeocodeResponseToCandidates', () => {
	it('parses scientific-notation coordinates to the correct decimal value', () => {
		// A real captured Transitous response for "Sagrada Familia Barcelona" (2026-09-04):
		// numbers print as "4.1403983999999994E1", not "41.403984". That is still a
		// syntactically valid JSON number, so `JSON.parse` (used here, exactly as
		// `Response.json()` would) already decodes it correctly before this function ever
		// sees it — this test exists so a future change cannot silently reintroduce a
		// manual decimal parse that mishandles this shape.
		const raw = JSON.parse(
			'[{"type":"STOP","name":"Sagrada Fam\\u00edlia","lat":4.1403983999999994E1,"lon":2.175106E0,"country":"ES","tz":"Europe/Madrid","areas":[{"name":"Barcelona","adminLevel":6E0,"matched":true}]}]'
		) as TransitousGeocodeResponse;

		const [candidate] = mapGeocodeResponseToCandidates(raw);

		expect(candidate.coordinates.latitude).toBe(41.403983999999994);
		expect(candidate.coordinates.longitude).toBe(2.175106);
		expect(candidate.name).toBe('Sagrada Família');
		expect(candidate.countryCode).toBe('ES');
		expect(candidate.timeZone).toBe('Europe/Madrid');
	});

	it('keeps every candidate for an ambiguous name rather than picking one', () => {
		// Real shape of a "Barcelona" search (2026-09-04): the Catalan city, the Venezuelan
		// city and a Philippine one, in that order. Issue #64: "returning one silent guess
		// is wrong" — this function must not narrow this to a single result.
		const raw: TransitousGeocodeResponse = [
			{ type: 'PLACE', name: 'Barcelona', lat: 41.3825802, lon: 2.177073, country: 'ES', tz: 'Europe/Madrid' },
			{ type: 'PLACE', name: 'Barcelona', lat: 10.1325951, lon: -64.6819583, country: 'VE', tz: 'America/Caracas' },
			{ type: 'PLACE', name: 'Barcelona', lat: 12.8682088, lon: 124.1418908, country: 'PH', tz: 'Asia/Manila' }
		];

		const candidates = mapGeocodeResponseToCandidates(raw);

		expect(candidates).toHaveLength(3);
		expect(candidates.map((c) => c.countryCode)).toEqual(['ES', 'VE', 'PH']);
		expect(candidates.map((c) => c.timeZone)).toEqual(['Europe/Madrid', 'America/Caracas', 'Asia/Manila']);
	});

	it('sorts admin areas broadest first, regardless of input order', () => {
		const raw: TransitousGeocodeResponse = [
			{
				type: 'STOP',
				name: "la Sagrada Família",
				lat: 41.4,
				lon: 2.17,
				country: 'ES',
				areas: [
					{ name: "l'Eixample", adminLevel: 9, matched: false },
					{ name: 'España', adminLevel: 2, matched: false },
					{ name: 'Barcelona', adminLevel: 6, matched: true },
					{ name: 'Catalunya', adminLevel: 4, matched: false }
				]
			}
		];

		const [candidate] = mapGeocodeResponseToCandidates(raw);

		expect(candidate.areas.map((a) => a.name)).toEqual(['España', 'Catalunya', 'Barcelona', "l'Eixample"]);
		expect(candidate.areas.find((a) => a.name === 'Barcelona')?.matched).toBe(true);
		expect(candidate.areas.find((a) => a.name === 'España')?.matched).toBe(false);
	});

	it('treats a missing country, timezone or areas list as unknown, not a default', () => {
		const raw: TransitousGeocodeResponse = [{ type: 'PLACE', name: 'Somewhere', lat: 0, lon: 0 }];

		const [candidate] = mapGeocodeResponseToCandidates(raw);

		expect(candidate.countryCode).toBeUndefined();
		expect(candidate.timeZone).toBeUndefined();
		expect(candidate.areas).toEqual([]);
	});

	it('resolves an empty response to an empty candidate list, not an error', () => {
		expect(mapGeocodeResponseToCandidates([])).toEqual([]);
	});
});
