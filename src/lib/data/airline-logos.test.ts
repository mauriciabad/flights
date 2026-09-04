import { describe, expect, it } from 'vitest';
import { AIRLINE_LOGO_BASE_URL, airlineLogoUrl, airlineMonogram } from './airline-logos';

describe('airlineLogoUrl', () => {
	it('builds the documented Kiwi path, with the server-side default that stops a 404', () => {
		expect(airlineLogoUrl('FR')).toBe(`${AIRLINE_LOGO_BASE_URL}/64x64/FR.png?default=airline.png`);
	});

	it('normalises a code the way an IATA code is written, whatever an adapter handed us', () => {
		expect(airlineLogoUrl(' fr ')).toBe(airlineLogoUrl('FR'));
	});

	it('carries nothing but the code, which is the whole privacy argument for using it', () => {
		// docs/prompts/005-ui-quality.md: no trackers. The check that matters is not "does
		// the CDN promise to behave" but "is there anywhere in this URL for a search, a
		// date, a party size or an identifier to hide". There is not, and this test is
		// what keeps it that way when somebody later wants to add a size or a theme param.
		const url = new URL(airlineLogoUrl('VR'));
		expect([...url.searchParams.keys()]).toEqual(['default']);
		expect(url.pathname).toBe('/airlines/64x64/VR.png');
	});

	it('escapes a code rather than letting it shape the path', () => {
		expect(airlineLogoUrl('../secret')).not.toContain('../');
	});
});

describe('airlineMonogram', () => {
	it('takes two letters from a one-word name and one from each of the first two otherwise', () => {
		expect(airlineMonogram('Ryanair')).toBe('RY');
		expect(airlineMonogram('Cabo Verde Airlines')).toBe('CV');
		expect(airlineMonogram('TAP Portugal')).toBe('TP');
	});

	it('answers with something rather than nothing for a name that is not one', () => {
		// Never a broken image and never an empty box: issue #11's bar for "total".
		expect(airlineMonogram('   ')).toBe('?');
		expect(airlineMonogram('')).toBe('?');
	});
});
