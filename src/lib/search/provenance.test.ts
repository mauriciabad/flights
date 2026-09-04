import { describe, expect, it } from 'vitest';
import type { AnyProvider, ProviderId, ProviderResult } from '../providers/types';
import { providerAnswer, recordProviderResult } from './provenance';
import type { ProviderStatus } from './types';

const RYANAIR: Pick<AnyProvider, 'id' | 'kind' | 'label'> = {
	id: 'ryanair',
	kind: 'flight',
	label: 'Ryanair'
};

function okResult<T>(data: T, requestsUsed = 1): ProviderResult<T> {
	return { ok: true, data, source: { providerId: 'ryanair', fetchedAt: '2026-10-01T09:00:00.000Z' }, requestsUsed };
}

function failedResult<T>(message: string, requestsUsed = 1): ProviderResult<T> {
	return {
		ok: false,
		error: { code: 'network-error', message },
		source: { providerId: 'ryanair', fetchedAt: '2026-10-01T09:00:00.000Z' },
		requestsUsed
	};
}

function statuses(): Map<ProviderId, ProviderStatus> {
	return new Map<ProviderId, ProviderStatus>();
}

describe('recordProviderResult', () => {
	it('counts an empty ok answer as an answer, not as silence (issue #130)', () => {
		const status = statuses();
		// Exactly what Ryanair returns for BVC and RAI: its adapter maps the routes
		// endpoint's 404 to an ok, empty list, because "not on our network" is an answer.
		recordProviderResult(status, RYANAIR, okResult<string[]>([]));
		recordProviderResult(status, RYANAIR, okResult<string[]>([]));

		const ryanair = status.get('ryanair');
		expect(ryanair).toMatchObject({ okCalls: 2, okCallsWithData: 0, requestsUsed: 2 });
		expect(ryanair?.lastError).toBeUndefined();
		expect(providerAnswer(ryanair!)).toBe('nothing-found');
	});

	it('separates answered-with-data from answered-with-nothing', () => {
		const status = statuses();
		recordProviderResult(status, RYANAIR, okResult(['STN', 'DUB']));

		expect(providerAnswer(status.get('ryanair')!)).toBe('answered');
		expect(status.get('ryanair')).toMatchObject({ okCalls: 1, okCallsWithData: 1 });
	});

	it('keeps counting ok calls across a mix of empty and non-empty answers', () => {
		const status = statuses();
		recordProviderResult(status, RYANAIR, okResult<string[]>([]));
		recordProviderResult(status, RYANAIR, okResult(['STN']));
		recordProviderResult(status, RYANAIR, okResult<string[]>([]));

		expect(status.get('ryanair')).toMatchObject({ okCalls: 3, okCallsWithData: 1 });
		expect(providerAnswer(status.get('ryanair')!)).toBe('answered');
	});

	it('reports a current failure ahead of earlier successes, and still bills the request', () => {
		const status = statuses();
		recordProviderResult(status, RYANAIR, okResult(['STN']));
		recordProviderResult(status, RYANAIR, failedResult('Failed to fetch'));

		const ryanair = status.get('ryanair');
		expect(ryanair).toMatchObject({ okCalls: 1, okCallsWithData: 1, requestsUsed: 2 });
		expect(ryanair?.lastError?.message).toBe('Failed to fetch');
		expect(providerAnswer(ryanair!)).toBe('failed');
		// lastFetchedAt survives the failure: it is when this provider last really answered.
		expect(ryanair?.lastFetchedAt).toBe('2026-10-01T09:00:00.000Z');
	});

	it('clears a failure once the provider answers again', () => {
		const status = statuses();
		recordProviderResult(status, RYANAIR, failedResult('Failed to fetch'));
		recordProviderResult(status, RYANAIR, okResult<string[]>([]));

		expect(status.get('ryanair')?.lastError).toBeUndefined();
		expect(providerAnswer(status.get('ryanair')!)).toBe('nothing-found');
	});

	it('treats a non-list payload as data, since it has no length to be empty', () => {
		const status = statuses();
		recordProviderResult(status, RYANAIR, okResult({ message: 'ok' }));

		expect(providerAnswer(status.get('ryanair')!)).toBe('answered');
	});
});

describe('providerAnswer', () => {
	it('reads a recorded-but-never-resolved provider as not asked', () => {
		expect(providerAnswer({ okCalls: 0, okCallsWithData: 0 })).toBe('not-asked');
	});
});
