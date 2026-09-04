import { describe, expect, it } from 'vitest';
import { femaleDormFit, femaleDormFitMessage, isFemaleDormSelectable } from './female-dorm-fit';

describe('femaleDormFit', () => {
	it('is "none" when the group has zero female travellers - issue #27\'s hard rule', () => {
		expect(femaleDormFit(4, 0)).toBe('none');
		expect(femaleDormFit(1, 0)).toBe('none');
	});

	it('is "some" for a mixed group - females cover part of the party, not all of it', () => {
		expect(femaleDormFit(4, 1)).toBe('some');
		expect(femaleDormFit(4, 3)).toBe('some');
	});

	it('is "all" when every traveller is female', () => {
		expect(femaleDormFit(3, 3)).toBe('all');
		expect(femaleDormFit(1, 1)).toBe('all');
	});

	it('treats females exceeding travellers as "all" defensively rather than "some"', () => {
		expect(femaleDormFit(2, 5)).toBe('all');
	});

	it('is "unspecified" when females is absent, per search-query.ts: "not the same thing as 0"', () => {
		expect(femaleDormFit(2, undefined)).toBe('unspecified');
	});

	it('defaults travellers to DEFAULT_TRAVELLERS (1) when omitted, matching search-query.ts', () => {
		expect(femaleDormFit(undefined, 1)).toBe('all');
		expect(femaleDormFit(undefined, 0)).toBe('none');
	});
});

describe('isFemaleDormSelectable', () => {
	it('is false for "none" and "some" - a female-only dorm must never stand in as the group total', () => {
		expect(isFemaleDormSelectable('none')).toBe(false);
		expect(isFemaleDormSelectable('some')).toBe(false);
	});

	it('is true for "all" and "unspecified"', () => {
		expect(isFemaleDormSelectable('all')).toBe(true);
		expect(isFemaleDormSelectable('unspecified')).toBe(true);
	});
});

describe('femaleDormFitMessage', () => {
	it('explains the shortfall by name for a mixed group, not just "unavailable"', () => {
		expect(femaleDormFitMessage('some', 4, 1)).toContain('1 of 4');
	});

	it('states the zero-female case plainly', () => {
		expect(femaleDormFitMessage('none', 2, 0)).toMatch(/no female travellers/i);
	});

	it('names the assumption for the unspecified case rather than implying it was checked', () => {
		expect(femaleDormFitMessage('unspecified', 2, undefined)).toMatch(/no gender breakdown/i);
	});

	it('has no caveat for a fully-eligible group', () => {
		expect(femaleDormFitMessage('all', 2, 2)).toBeUndefined();
	});
});
