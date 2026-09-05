import { describe, expect, it } from 'vitest';
import {
	describePriceFreshness,
	describeSourceGroups,
	describeSources,
	describeStaleSources,
	oldestSourceAgeMs
} from './view-model';
import { makeScoredResult } from './test-support';
import type { ProvenancePart } from './types';

describe('describePriceFreshness', () => {
	it('renders a just-fetched price as plain and unflagged', () => {
		const display = describePriceFreshness({ tier: 'fresh', retrievedAgeMs: 2_000 });
		expect(display.tone).toBe('neutral');
		expect(display.label).toBe('Just checked');
	});

	it('refuses to call an hour-old cached price current, however finished the search is', () => {
		// The contradiction this fixes: since #151 the same card's footer reads "via
		// Ryanair · fetched 58 minutes ago", and a hit at 59 minutes is ordinary under
		// ryanair.ts's one-hour fare TTL. Both lines come off `retrievedAgeMs` now.
		const display = describePriceFreshness({ tier: 'fresh', retrievedAgeMs: 58 * 60_000 });
		expect(display.label).not.toMatch(/current/i);
		expect(display.label).toBe('Checked 58 minutes ago');
	});

	// Issue #170. `retrievedAgeMs` is our clock: when this app last asked. No adapter
	// here can say when the provider last moved the price, so no label may imply it.
	// "Priced 58 minutes ago" did exactly that, over a number that never knew it.
	it.each([
		{ tier: 'fresh', retrievedAgeMs: 2_000 },
		{ tier: 'fresh', retrievedAgeMs: 58 * 60_000 },
		{ tier: 'stale', retrievedAgeMs: 0 },
		{
			tier: 'expired-fallback',
			retrievedAgeMs: 2 * 24 * 60 * 60 * 1000,
			reason: 'quota-exceeded',
			message: 'Quota used up for now.'
		}
	] as const)('never claims to know when the price was set ($tier)', (freshness) => {
		const { label } = describePriceFreshness(freshness);
		expect(label).not.toMatch(/priced/i);
		expect(label).not.toMatch(/current price/i);
	});

	it('renders stale distinctly, as a search still in progress rather than a finished number', () => {
		const display = describePriceFreshness({ tier: 'stale', retrievedAgeMs: 0 });
		expect(display.tone).toBe('info');
		expect(display.label).toMatch(/confirming/i);
	});

	it('renders expired-fallback with its age and the real reason, never as current', () => {
		const display = describePriceFreshness({
			tier: 'expired-fallback',
			retrievedAgeMs: 2 * 24 * 60 * 60 * 1000,
			reason: 'quota-exceeded',
			message: 'Quota used up for now.'
		});
		expect(display.tone).toBe('warning');
		expect(display.label).toContain('days ago');
		expect(display.label).toContain('Quota used up for now.');
	});
});

describe('describeSources', () => {
	const NOW = Date.parse('2026-10-14T12:00:00.000Z');
	const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

	const part = (
		overrides: Partial<ProvenancePart> & Pick<ProvenancePart, 'providerLabel' | 'fetchedAt'>
	): ProvenancePart => ({
		part: 'outboundFlight',
		providerId: 'ryanair',
		...overrides
	});

	it('says nothing at all when no part carries a tracked source', () => {
		expect(describeSources([], NOW)).toBeUndefined();
	});

	it('keeps the one-age sentence when every source was fetched in the same search', () => {
		const text = describeSources(
			[
				part({ providerLabel: 'Ryanair (no key required)', fetchedAt: minutesAgo(0) }),
				part({ providerLabel: 'OSRM (walking & driving)', fetchedAt: minutesAgo(0) })
			],
			NOW
		);
		expect(text).toBe('via Ryanair (no key required) & OSRM (walking & driving), fetched this minute');
	});

	// Issue #289, measured on a real page: with the cache aged past every flight TTL and
	// reloaded, Kiwi, Ryanair and Hostelworld all came back 0 minutes old and the footer
	// still read "fetched 3 hours ago". The 3 hours belonged to an OSRM road route, whose
	// own TTL is 30 days, so nothing ever refetched it and the number could only get worse.
	// A price this app retrieved a minute ago must never be printed at a road route's age.
	it('never prints the age of a road route over a fare this app just retrieved', () => {
		const text = describeSources(
			[
				part({ providerLabel: 'Kiwi.com (no key required)', fetchedAt: minutesAgo(0) }),
				part({ providerLabel: 'OSRM (walking & driving)', part: 'transferToHotel', providerId: 'osrm', fetchedAt: minutesAgo(180) })
			],
			NOW
		);
		expect(text).toBe(
			'via Kiwi.com (no key required), fetched this minute; OSRM (walking & driving), fetched 3 hours ago'
		);
	});

	it('groups every source that shares an age, freshest group first', () => {
		const text = describeSources(
			[
				part({ providerLabel: 'Ryanair (no key required)', fetchedAt: minutesAgo(180) }),
				part({ providerLabel: 'Kiwi.com (no key required)', fetchedAt: minutesAgo(0) }),
				part({ providerLabel: 'Hostelworld (no key required)', part: 'stay', fetchedAt: minutesAgo(0) })
			],
			NOW
		);
		expect(text).toBe(
			'via Kiwi.com (no key required) & Hostelworld (no key required), fetched this minute; Ryanair (no key required), fetched 3 hours ago'
		);
	});

	// Both legs come from one provider and only one of them was refetched. The provider is
	// named once, at the age of its oldest contribution: a source is as fresh as the least
	// fresh thing it gave this card, and printing it twice would say the card has two
	// Kiwis on it.
	it('names a provider once, at the age of the oldest part it supplied', () => {
		const text = describeSources(
			[
				part({ providerLabel: 'Kiwi.com (no key required)', fetchedAt: minutesAgo(0) }),
				part({ providerLabel: 'Kiwi.com (no key required)', part: 'onwardFlight', fetchedAt: minutesAgo(120) })
			],
			NOW
		);
		expect(text).toBe('via Kiwi.com (no key required), fetched 2 hours ago');
	});
});

// Issue #312 -----------------------------------------------------------------

describe('the sources, as a list rather than a sentence', () => {
	const NOW = Date.parse('2026-10-14T12:00:00.000Z');
	const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
	const part = (
		overrides: Partial<ProvenancePart> & Pick<ProvenancePart, 'providerLabel' | 'fetchedAt'>
	): ProvenancePart => ({ part: 'outboundFlight', providerId: 'ryanair', ...overrides });

	const owners = [
		part({ providerLabel: 'Transitous', fetchedAt: minutesAgo(5) }),
		part({ providerLabel: 'Kiwi.com (no key required)', fetchedAt: minutesAgo(6) }),
		part({ providerLabel: 'Hostelworld (no key required)', fetchedAt: minutesAgo(6) }),
		part({ providerLabel: 'OSRM (walking & driving)', fetchedAt: minutesAgo(21 * 60) })
	];

	it('groups by age, freshest first, exactly as the sentence did', () => {
		// The owner's own footer, the one he could not read. Same grouping, laid out as rows.
		expect(describeSourceGroups(owners, NOW)).toEqual([
			{ age: '5 minutes ago', ageMs: 5 * 60_000, sources: ['Transitous'] },
			{
				age: '6 minutes ago',
				ageMs: 6 * 60_000,
				sources: ['Kiwi.com (no key required)', 'Hostelworld (no key required)']
			},
			{ age: '21 hours ago', ageMs: 21 * 60 * 60_000, sources: ['OSRM (walking & driving)'] }
		]);
	});

	it('still builds the sentence from those same groups', () => {
		// The sentence is the control's accessible name now, so a reader who never opens the
		// panel hears what it would have said. It must not drift from the rows.
		expect(describeSources(owners, NOW)).toBe(
			'via Transitous, fetched 5 minutes ago; Kiwi.com (no key required) & Hostelworld (no key required), fetched 6 minutes ago; OSRM (walking & driving), fetched 21 hours ago'
		);
	});

	it('has no groups when nothing carries a tracked source', () => {
		expect(describeSourceGroups([], NOW)).toEqual([]);
	});

	it('ages a card by its oldest source', () => {
		expect(oldestSourceAgeMs(owners, NOW)).toBe(21 * 60 * 60_000);
		expect(oldestSourceAgeMs([], NOW)).toBe(0);
	});
});

describe('the staleness mark that stays on the card', () => {
	const NOW = Date.parse('2026-10-14T12:00:00.000Z');
	const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
	const part = (minutes: number): ProvenancePart => ({
		part: 'outboundFlight',
		providerId: 'ryanair',
		providerLabel: 'Ryanair (no key required)',
		fetchedAt: minutesAgo(minutes)
	});

	it('says nothing while every source is inside the hour', () => {
		// One hour is the longest TTL any adapter gives an answer carrying money. Under it,
		// marking the card old would be marking a 30-day road route old, which is the exact
		// conflation issue #289 removed.
		expect(describeStaleSources([part(5), part(59)], NOW)).toBeUndefined();
	});

	it('marks the card once a source is past the longest priced TTL in the app', () => {
		expect(describeStaleSources([part(5), part(21 * 60)], NOW)).toBe('oldest 21 hours ago');
	});

	it('names it as the oldest, not as the card', () => {
		// The whole of #289: one age printed over sources whose TTLs range from 5 minutes to
		// 30 days reads as a claim about all of them.
		expect(describeStaleSources([part(90)], NOW)).toContain('oldest');
	});

	it('says nothing when there is nothing to age', () => {
		expect(describeStaleSources([], NOW)).toBeUndefined();
	});
});
