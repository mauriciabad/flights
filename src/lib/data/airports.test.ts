import { describe, expect, it } from 'vitest';
import {
	deriveSizeClass,
	getAirport,
	iconForAirport,
	iconForCity,
	searchAirports,
	sizeClassOf
} from './airports';

describe('sizeClassOf', () => {
	it('classes a large hub as large', async () => {
		// Vienna International — large_airport in OurAirports.
		expect(await sizeClassOf('VIE')).toBe('large');
	});

	it('classes a regional airport as medium', async () => {
		// Alghero-Fertilia — medium_airport in OurAirports. Issue #11 acceptance:
		// sizeClassOf('VIE') and sizeClassOf('AHO') must return different classes.
		expect(await sizeClassOf('AHO')).toBe('medium');
	});

	it('returns undefined, never throws, for a code not in the dataset', async () => {
		await expect(sizeClassOf('ZZZ')).resolves.toBeUndefined();
	});
});

describe('deriveSizeClass', () => {
	it('maps the three OurAirports airport types', () => {
		expect(deriveSizeClass('large_airport')).toBe('large');
		expect(deriveSizeClass('medium_airport')).toBe('medium');
		expect(deriveSizeClass('small_airport')).toBe('small');
	});

	it('returns undefined for types outside the large/medium/small ladder', () => {
		expect(deriveSizeClass('seaplane_base')).toBeUndefined();
		expect(deriveSizeClass('heliport')).toBeUndefined();
		expect(deriveSizeClass(undefined)).toBeUndefined();
	});

	it('promotes a known high-volume hub even when OurAirports calls it medium', () => {
		// Regression guard: a hub in the curated passenger-volume list must win over a
		// medium_airport type, since that override exists specifically to correct cases
		// like this.
		expect(deriveSizeClass('medium_airport', 'AMS')).toBe('large');
	});
});

describe('getAirport', () => {
	it('finds a known airport by IATA code, case-insensitively, as a domain Airport', async () => {
		const airport = await getAirport('vie');
		expect(airport?.name).toContain('Vienna');
		expect(airport?.city.country.isoCode).toBe('AT');
		expect(airport?.sizeClass).toBe('large');
	});

	it('returns undefined rather than throwing for an unknown code', async () => {
		await expect(getAirport('ZZZ')).resolves.toBeUndefined();
		await expect(getAirport('')).resolves.toBeUndefined();
	});

	it('gives every airport a concrete sizeClass, even ones OurAirports cannot classify', async () => {
		// A scheduled seaplane base/heliport with an IATA code but no large/medium/small
		// OurAirports type — must still satisfy Airport.sizeClass being required.
		const airport = await getAirport('PPV'); // Port Protection Seaplane Base, AK
		expect(airport?.sizeClass).toBe('small');
	});
});

describe('searchAirports', () => {
	it('ranks an exact IATA match first', async () => {
		const results = await searchAirports('vie');
		expect(results[0]?.iataCode).toBe('VIE');
	});

	it('matches by city name', async () => {
		const results = await searchAirports('vienna');
		expect(results.some((a) => a.iataCode === 'VIE')).toBe(true);
	});

	it('returns nothing for a blank query rather than the whole dataset', async () => {
		expect(await searchAirports('   ')).toEqual([]);
	});
});

describe('iconForCity / iconForAirport', () => {
	it('returns a flag for a known country', () => {
		const icon = iconForCity({ country: { isoCode: 'AT', name: 'Austria' } });
		expect(icon.kind).toBe('flag');
		expect(icon.glyph).toBe('🇦🇹');
		expect(icon.label).toContain('Austria');
	});

	it('returns a deliberate placeholder, not a throw, for an unrecognisable country', () => {
		expect(() => iconForCity({ country: { isoCode: '', name: '' } })).not.toThrow();
		const icon = iconForCity({ country: { isoCode: '', name: '' } });
		expect(icon.kind).toBe('placeholder');
		expect(icon.glyph).toBeTruthy();
		expect(icon.label).toBeTruthy();
	});

	it('is total for garbage or missing input', () => {
		expect(iconForCity({ country: { isoCode: 'NOTACODE', name: 'Nowhere' } })).toEqual(
			expect.objectContaining({ kind: 'placeholder' })
		);
		expect(iconForCity(null)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForCity(undefined)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForAirport(undefined)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
		expect(iconForAirport(null)).toEqual(expect.objectContaining({ kind: 'placeholder' }));
	});

	it('resolves a full Airport to its country flag', async () => {
		const airport = await getAirport('VIE');
		const icon = iconForAirport(airport);
		expect(icon.kind).toBe('flag');
		expect(icon.glyph).toBe('🇦🇹');
	});
});
