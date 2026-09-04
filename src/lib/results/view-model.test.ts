import { describe, expect, it } from 'vitest';
import { describePriceFreshness } from './view-model';
import { makeScoredResult } from './test-support';

describe('describePriceFreshness', () => {
	it('renders a just-fetched price as plain and unflagged', () => {
		const display = describePriceFreshness({ tier: 'fresh', ageMs: 2_000 });
		expect(display.tone).toBe('neutral');
		expect(display.label).toBe('Current price');
	});

	it('refuses to call an hour-old cached price current, however finished the search is', () => {
		// The contradiction this fixes: since #151 the same card's footer reads "via
		// Ryanair · fetched 58 minutes ago", and a hit at 59 minutes is ordinary under
		// ryanair.ts's one-hour fare TTL. Both lines come off `ageMs` now.
		const display = describePriceFreshness({ tier: 'fresh', ageMs: 58 * 60_000 });
		expect(display.label).not.toMatch(/current/i);
		expect(display.label).toBe('Priced 58 minutes ago');
	});

	it('renders stale distinctly, as a search still in progress rather than a finished number', () => {
		const display = describePriceFreshness({ tier: 'stale', ageMs: 0 });
		expect(display.tone).toBe('info');
		expect(display.label).toMatch(/confirming/i);
	});

	it('renders expired-fallback with its age and the real reason, never as current', () => {
		const display = describePriceFreshness({
			tier: 'expired-fallback',
			ageMs: 2 * 24 * 60 * 60 * 1000,
			reason: 'quota-exceeded',
			message: 'Quota used up for now.'
		});
		expect(display.tone).toBe('warning');
		expect(display.label).toContain('days ago');
		expect(display.label).toContain('Quota used up for now.');
	});
});
