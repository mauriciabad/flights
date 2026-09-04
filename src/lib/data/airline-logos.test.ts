import { describe, expect, it } from 'vitest';
import { airlineLogoUrl, airlineMonogram } from './airline-logos';

describe('airlineLogoUrl', () => {
	it('builds a pics.avs.io URL keyed by the uppercased IATA code', () => {
		expect(airlineLogoUrl('fr')).toBe('https://pics.avs.io/64/64/FR.png');
		expect(airlineLogoUrl('TP')).toBe('https://pics.avs.io/64/64/TP.png');
	});

	it('trims incidental whitespace rather than baking it into the URL', () => {
		expect(airlineLogoUrl(' VR ')).toBe('https://pics.avs.io/64/64/VR.png');
	});
});

describe('airlineMonogram', () => {
	it('takes the first two letters of a single-word name', () => {
		expect(airlineMonogram('Ryanair')).toBe('RY');
	});

	it('takes the first letter of each word for a two-word name', () => {
		expect(airlineMonogram('Cabo Verde Airlines')).toBe('CV');
	});

	it('falls back to a neutral placeholder for an empty name rather than throwing', () => {
		expect(airlineMonogram('')).toBe('?');
		expect(airlineMonogram('   ')).toBe('?');
	});

	it('is total for a name with irregular spacing', () => {
		expect(airlineMonogram('  TAP   Portugal  ')).toBe('TP');
	});
});
