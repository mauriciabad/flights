import { describe, expect, it } from 'vitest';
import { citySearchAliases, cleanMunicipality, displayCityName } from './airport-city-names';

describe('cleanMunicipality', () => {
	it('passes a plain name through unchanged', () => {
		expect(cleanMunicipality('Vienna')).toBe('Vienna');
	});

	it('takes the segment before a "City, Region" comma', () => {
		expect(cleanMunicipality('Birmingham, West Midlands')).toBe('Birmingham');
		expect(cleanMunicipality('London, Essex')).toBe('London');
	});

	it('collapses a duplicated "City, City" pair, which is what OurAirports has for LTN', () => {
		expect(cleanMunicipality('Luton, Luton')).toBe('Luton');
	});

	it('strips a parenthetical qualifier, with or without a space before it', () => {
		expect(cleanMunicipality('Pisa (PI)')).toBe('Pisa');
		expect(cleanMunicipality('Sandefjord(Torp)')).toBe('Sandefjord');
	});

	it('strips the parenthetical before splitting on the comma, since CDG has its only comma inside one', () => {
		// Splitting on the comma first would cut this to "Paris (Roissy-en-France", which
		// is not a name that should ever reach a result card or Agoda's search box.
		expect(cleanMunicipality("Paris (Roissy-en-France, Val-d'Oise)")).toBe('Paris');
	});
});

describe('displayCityName', () => {
	it('names the city a traveller would say for the satellite airports issue #136 reported', () => {
		expect(displayCityName('BGY', 'Orio al Serio (BG)')).toBe('Bergamo');
		expect(displayCityName('MXP', 'Ferno (VA)')).toBe('Milan');
		expect(displayCityName('LIN', 'Segrate (MI)')).toBe('Milan');
		expect(displayCityName('MRS', 'Marignane, Bouches-du-Rhône')).toBe('Marseille');
		expect(displayCityName('OTP', 'Otopeni')).toBe('Bucharest');
		expect(displayCityName('BVC', 'Rabil')).toBe('Boa Vista');
	});

	it('fixes the rows the structural cleanup reaches without any curation', () => {
		expect(displayCityName('STN', 'London, Essex')).toBe('London');
		expect(displayCityName('PSA', 'Pisa (PI)')).toBe('Pisa');
		expect(displayCityName("CDG", "Paris (Roissy-en-France, Val-d'Oise)")).toBe('Paris');
	});

	it('never renames a real town into the big city a budget carrier markets it as', () => {
		// The other half of the same judgement: these airports ARE in these towns, an hour
		// or more from the city on the ticket. Printing the marketed name would be the same
		// wrong belief issue #136 is about, pointing the other way.
		expect(displayCityName('GRO', 'Girona')).toBe('Girona');
		expect(displayCityName('CRL', 'Charleroi')).toBe('Charleroi');
		expect(displayCityName('BVA', 'Beauvais')).toBe('Beauvais');
		expect(displayCityName('NYO', 'Nyköping')).toBe('Nyköping');
		expect(displayCityName('TRF', 'Sandefjord(Torp)')).toBe('Sandefjord');
	});

	it('does not promise the city itself for an airport two hours outside it', () => {
		// The cleanup alone would turn "Frankfurt am Main (Lautzenhausen)" into
		// "Frankfurt am Main" for an airport 120 km away. The airport's own name is the
		// honest answer: findable under Frankfurt, never claiming to be in it.
		expect(displayCityName('HHN', 'Frankfurt am Main (Lautzenhausen)')).toBe('Frankfurt Hahn');
	});

	it('falls back to the raw value rather than an empty label when there is nothing to clean', () => {
		expect(displayCityName('ZZZ', '(unknown)')).toBe('(unknown)');
	});
});

describe('citySearchAliases', () => {
	it('keeps the marketed city searchable for airports it never displays it for', () => {
		expect(citySearchAliases('BVA', 'Beauvais')).toContain('Paris');
		expect(citySearchAliases('GRO', 'Girona')).toContain('Barcelona');
		expect(citySearchAliases('REU', 'Reus')).toContain('Barcelona');
		expect(citySearchAliases('TRF', 'Sandefjord(Torp)')).toContain('Oslo');
		expect(citySearchAliases('FMM', 'Memmingen')).toContain('Munich');
		expect(citySearchAliases('FRL', 'Forlì (FC)')).toContain('Bologna');
	});

	it('keeps the old municipality searchable for every airport it renames', () => {
		// Renaming a card must never make an airport harder to find than it was.
		expect(citySearchAliases('BGY', 'Orio al Serio (BG)')).toContain('Orio al Serio (BG)');
		expect(citySearchAliases('BVC', 'Rabil')).toContain('Rabil');
		expect(citySearchAliases('STN', 'London, Essex')).toContain('London, Essex');
	});

	it('adds nothing for an airport whose municipality already is its display name', () => {
		expect(citySearchAliases('VIE', 'Vienna')).toEqual([]);
	});
});
