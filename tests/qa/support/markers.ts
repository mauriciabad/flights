/**
 * How this suite tells a recorded response from a real one.
 *
 * It does not have a scheme of its own. Issue #156 landed one — `tests/e2e/fixtures/
 * markers.json`, read by `tests/e2e/support/fixture-markers.ts`, `tests/e2e/guard.spec.ts`
 * and `tools/probe-results.mjs` — and a second scheme would mean two things to keep in sync
 * and two ways for a leaked fixture to slip past. This file is the seam: it re-exports that
 * manifest and adds the two helpers the QA checks need on top.
 *
 * If the token pool changes, it changes in `markers.json` and everything here follows.
 */

import { FIXTURE_MARKER_TOKENS, FIXTURE_TEXT_TOKEN } from '../../e2e/support/fixture-markers';

export { FIXTURE_MARKER_TOKENS, FIXTURE_TEXT_TOKEN };

export interface MarkerHit {
	token: string;
	/** Enough of the surrounding text to see what leaked, without dumping a whole body. */
	context: string;
}

export function findTestMarkers(text: string): MarkerHit[] {
	const hits: MarkerHit[] = [];
	for (const token of FIXTURE_MARKER_TOKENS) {
		let index = text.indexOf(token);
		while (index !== -1 && hits.length < 20) {
			hits.push({ token, context: text.slice(Math.max(0, index - 60), index + token.length + 60) });
			index = text.indexOf(token, index + token.length);
		}
	}
	return hits;
}

export function hasTestMarker(text: string): boolean {
	return FIXTURE_MARKER_TOKENS.some((token) => text.includes(token));
}

export function describeMarkerHits(hits: MarkerHit[]): string {
	return hits.map((hit) => `  - ${hit.token} in "...${hit.context.replace(/\s+/g, ' ')}..."`).join('\n');
}
