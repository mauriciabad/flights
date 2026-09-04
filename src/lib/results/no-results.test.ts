import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '$lib/search';
import { explainNoResults, fixSentence, flightSourceLines, pickKeyGapFix } from './no-results';
import type { NoResultsInput, RegisteredFlightProvider } from './no-results';

const BVC = { code: 'BVC', name: 'Boa Vista' };
const PFO = { code: 'PFO', name: 'Pafos' };

function status(overrides: Partial<ProviderStatus> & Pick<ProviderStatus, 'providerId' | 'label'>): ProviderStatus {
	return {
		kind: 'flight',
		requestsUsed: 0,
		okCalls: 0,
		okCallsWithData: 0,
		...overrides
	};
}

/** Ryanair as it really behaves on BVC -> PFO: two calls, both ok, both empty. */
const ryanairEmpty = status({
	providerId: 'ryanair',
	label: 'Ryanair',
	requestsUsed: 2,
	okCalls: 2,
	okCallsWithData: 0,
	lastFetchedAt: '2026-10-01T09:00:00.000Z'
});

const cheapRoutesAnswered = status({
	providerId: 'travelpayouts-cheap-routes',
	label: 'Travelpayouts cheap routes (build-time)',
	okCalls: 3,
	okCallsWithData: 1
});

const registered = (overrides: Partial<RegisteredFlightProvider> = {}): RegisteredFlightProvider => ({
	id: 'flights-sky',
	label: 'Flights Sky',
	needsKey: true,
	usable: false,
	...overrides
});

const NO_KEYS: RegisteredFlightProvider[] = [
	{ id: 'ryanair', label: 'Ryanair', needsKey: false, usable: true },
	registered({ id: 'flights-sky', label: 'Flights Sky' }),
	registered({ id: 'skyscanner', label: 'Skyscanner (Sky Scrapper)' }),
	registered({ id: 'kiwi', label: 'Kiwi.com' })
];

function input(overrides: Partial<NoResultsInput> = {}): NoResultsInput {
	return {
		origin: BVC,
		destination: PFO,
		providers: [ryanairEmpty],
		registeredFlightProviders: NO_KEYS,
		candidateCount: 0,
		hasDirectRoute: false,
		...overrides
	};
}

describe('flightSourceLines', () => {
	it('reports an empty answer as an answer, naming the origin when only routes were asked about', () => {
		const [line] = flightSourceLines([ryanairEmpty], BVC, true);

		expect(line).toMatchObject({
			providerId: 'ryanair',
			answer: 'nothing-found',
			verdict: 'no routes from BVC',
			requestsUsed: 2
		});
		expect(line.rawError).toBeUndefined();
	});

	it('does not claim "no routes" once fares were also fetched', () => {
		const [line] = flightSourceLines([ryanairEmpty], BVC, false);

		expect(line.verdict).toBe('answered with nothing');
	});

	it('passes a provider failure through with its status code, never a rewritten one', () => {
		const [line] = flightSourceLines(
			[
				status({
					providerId: 'skyscanner',
					label: 'Skyscanner (Sky Scrapper)',
					lastError: { code: 'not-subscribed', message: 'You are not subscribed to this API.', status: 403 }
				})
			],
			BVC,
			true
		);

		expect(line.answer).toBe('failed');
		expect(line.rawError).toBe('403: You are not subscribed to this API.');
	});

	it('ignores providers of other kinds', () => {
		const lines = flightSourceLines(
			[ryanairEmpty, status({ providerId: 'osrm', label: 'OSRM', kind: 'transfer', okCalls: 1, okCallsWithData: 1 })],
			BVC,
			true
		);

		expect(lines.map((line) => line.providerId)).toEqual(['ryanair']);
	});
});

describe('pickKeyGapFix', () => {
	it('suggests the unconfigured flight provider with the largest free tier', () => {
		// Flights Sky's 50/month beats Sky Scrapper's 20 (settings/provider-catalog.ts).
		expect(pickKeyGapFix(NO_KEYS)).toMatchObject({
			providerId: 'flights-sky',
			monthlyQuota: 50,
			href: '/settings/#flights-sky',
			actionLabel: 'Add a Flights Sky key'
		});
	});

	it('moves on to the next provider once the largest one has a key', () => {
		const withFlightsSkyKey = NO_KEYS.map((provider) =>
			provider.id === 'flights-sky' ? { ...provider, usable: true } : provider
		);

		expect(pickKeyGapFix(withFlightsSkyKey)?.providerId).toBe('skyscanner');
	});

	it('never suggests a provider with no settings row to paste a key into', () => {
		// Kiwi is registered but has no settings card, so there is nowhere to send anyone.
		const onlyKiwiMissing: RegisteredFlightProvider[] = [registered({ id: 'kiwi', label: 'Kiwi.com' })];

		expect(pickKeyGapFix(onlyKiwiMissing)).toBeUndefined();
	});

	it('offers nothing once every keyed provider is configured', () => {
		expect(pickKeyGapFix(NO_KEYS.map((provider) => ({ ...provider, usable: true })))).toBeUndefined();
	});

	it('never suggests a keyless provider', () => {
		expect(pickKeyGapFix([{ id: 'ryanair', label: 'Ryanair', needsKey: false, usable: true }])).toBeUndefined();
	});
});

describe('explainNoResults', () => {
	it('says what the sources reported and does not blame the connection (issue #130)', () => {
		const explanation = explainNoResults(input());

		expect(explanation.cause).toBe('no-route-known');
		expect(explanation.title).toBe('No route out of BVC');
		expect(explanation.detail).toContain('Ryanair answered');
		expect(explanation.detail).toContain('no route out of Boa Vista (BVC)');
		expect(explanation.detail).toContain('Later dates will not change that.');
		// The two sentences the old copy asserted without evidence.
		expect(explanation.detail).not.toContain('workable connection');
		expect(explanation.detail).not.toContain('different destination');
	});

	it('offers the key that would let this search ask another source', () => {
		const explanation = explainNoResults(input());

		expect(explanation.fix).toMatchObject({ providerId: 'flights-sky', href: '/settings/#flights-sky' });
		expect(fixSentence(explanation.fix!, PFO)).toContain('50 requests a month');
	});

	it('names every empty-handed source, not just the first', () => {
		const explanation = explainNoResults(
			input({
				providers: [ryanairEmpty, status({ providerId: 'kiwi', label: 'Kiwi.com', okCalls: 1, okCallsWithData: 0 })]
			})
		);

		expect(explanation.detail).toContain('Ryanair and Kiwi.com answered');
		expect(explanation.detail).toContain('they have no route');
	});

	it('drops the "nothing flies from here" claim when a source did know routes', () => {
		const explanation = explainNoResults(input({ providers: [ryanairEmpty, cheapRoutesAnswered] }));

		expect(explanation.title).toBe('No stopover from BVC reaches PFO');
		expect(explanation.detail).toContain('Ryanair answered with no route out of Boa Vista (BVC)');
		expect(explanation.detail).toContain('knows routes from BVC, and none of them continues to Pafos (PFO)');
	});

	it('reports a priced search that found stopovers but no pairing', () => {
		const explanation = explainNoResults(input({ candidateCount: 3, providers: [cheapRoutesAnswered] }));

		expect(explanation.cause).toBe('no-priced-pairing');
		expect(explanation.title).toBe('3 stopovers, no priced trip');
		expect(explanation.detail).toContain('Different dates might.');
		// With fares fetched, "no routes from BVC" would be a claim about the wrong question.
		expect(explanation.sources[0].verdict).toBe('answered with flights');
	});

	it('keeps issue #107s direct-route ending, and never offers a key for it', () => {
		const explanation = explainNoResults(input({ hasDirectRoute: true }));

		expect(explanation.cause).toBe('direct-route');
		expect(explanation.title).toBe('Well served direct');
		expect(explanation.fix).toBeUndefined();
	});

	it('falls back to the bare IATA code when the airport dataset has no name yet', () => {
		const explanation = explainNoResults(input({ origin: { code: 'BVC' } }));

		expect(explanation.detail).toContain('no route out of BVC at all');
	});

	it('still explains itself when no flight provider was recorded at all', () => {
		const explanation = explainNoResults(input({ providers: [] }));

		expect(explanation.sources).toEqual([]);
		expect(explanation.title).toBe('No flight source answered');
		expect(explanation.detail).toContain('not a statement about the route');
	});
});
