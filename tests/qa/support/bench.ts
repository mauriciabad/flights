/**
 * The bench every QA check runs on: a browser with every provider answered from a recording,
 * every request counted, and every body it served kept for cross-checking against what
 * ended up on screen.
 *
 * ## Why this is not `tests/e2e/support/providers.ts`
 *
 * That module answers a request. This one answers it AND remembers it, because most of what
 * `pnpm qa` asserts is about the traffic rather than the pixels: how many requests one
 * search costs, which airlines a provider actually offered, whether a reload touched the
 * network at all. The e2e mocks stay exactly as they are; this reuses their fixtures rather
 * than their route handlers.
 *
 * ## Cost
 *
 * Nothing here spends the owner's quota. Metered providers (Agoda, Booking, Skyscanner,
 * Kiwi, Flights Sky) are always recorded — there is no mode in which `pnpm qa` calls them.
 * With `QA_LIVE=1` the keyless ones (Ryanair, OSRM, Transitous, Nominatim) go to the real
 * network instead, which costs nothing but a few requests and is the only way to notice a
 * provider changing its response shape. See tests/qa/README.md.
 */

import { test as base, expect, type BrowserContext, type Request, type Route } from '@playwright/test';
import type { ProviderId } from '../../../src/lib/providers/types';
import {
	AGODA_HOST,
	BOOKING_HOST,
	KIWI_PUBLIC_HOST,
	NOMINATIM_HOST,
	OSRM_HOST,
	RYANAIR_FARES_HOST,
	RYANAIR_WEB_HOST,
	TRANSITOUS_HOST,
	providerForUrl
} from './catalog';
import * as recorded from './responses';
import { UNBUDGETED_HOSTS } from '../budget';

/** Providers that cost the owner money when called for real. Never reached, in any mode. */
const METERED_HOSTS = new Set([AGODA_HOST, BOOKING_HOST, 'sky-scrapper.p.rapidapi.com', 'kiwi-com-cheap-flights.p.rapidapi.com', 'flights-sky.p.rapidapi.com']);

export const LIVE_MODE = process.env.QA_LIVE === '1';

export interface RecordedRequest {
	url: string;
	method: string;
	providerId: ProviderId | undefined;
	host: string;
	/** Milliseconds since the bench was installed, so a check can ask "did anything reach
	 * the network before the page painted". */
	atMs: number;
}

export interface BenchOptions {
	/** Milliseconds to hold every provider response back by. A reload that renders inside
	 * this window rendered from cache, which is the whole of the stale-first invariant. */
	responseDelayMs?: number;
	/** Extra response headers, per provider. Used to hand back RapidAPI's own rate-limit
	 * counters. `access-control-expose-headers` is added automatically for whatever is set
	 * here — a cross-origin header the browser cannot read is not a header the app can use. */
	headers?: Partial<Record<ProviderId, Record<string, string>>>;
	/** Answer these providers with a network failure instead of a body. */
	failing?: ProviderId[];
}

export class Bench {
	readonly requests: RecordedRequest[] = [];
	/** Every body served, in order, as text. `no-fabricated-flights.qa.ts` reads what a
	 * provider actually offered out of these rather than trusting the fixture files, so a
	 * bench that answered something unexpected cannot quietly widen what counts as real. */
	readonly bodies: { providerId: ProviderId | undefined; url: string; text: string; recorded: boolean }[] = [];
	readonly unrecognised: string[] = [];

	#startedAt = Date.now();
	#options: BenchOptions;

	constructor(options: BenchOptions) {
		this.#options = options;
	}

	/** Holds every later response back by `ms`. Set before a reload, it turns "did this come
	 * from cache" into a question a stopwatch can answer: anything on screen before the
	 * delay elapses cannot have come from the network. */
	delayResponsesBy(ms: number): void {
		this.#options = { ...this.#options, responseDelayMs: ms };
	}

	/** Wipes the request log without tearing the routes down — for "reload and prove nothing
	 * went out" checks, where the first load's traffic is not the traffic under test. */
	resetLog(): void {
		this.requests.length = 0;
		this.bodies.length = 0;
		this.#startedAt = Date.now();
	}

	countsByProvider(): Map<ProviderId | undefined, number> {
		const counts = new Map<ProviderId | undefined, number>();
		for (const request of this.requests) {
			counts.set(request.providerId, (counts.get(request.providerId) ?? 0) + 1);
		}
		return counts;
	}

	countFor(providerId: ProviderId): number {
		return this.requests.filter((request) => request.providerId === providerId).length;
	}

	bodiesFor(providerId: ProviderId): string[] {
		return this.bodies.filter((body) => body.providerId === providerId).map((body) => body.text);
	}

	/** Only what genuinely came off the network. In live mode the metered providers are still
	 * answered from a recording — there is no mode in which this suite calls them — so a check
	 * about what a real provider sent has to exclude those, or it would be reading the bench's
	 * own output back to itself. */
	liveBodies() {
		return this.bodies.filter((body) => !body.recorded);
	}

	/** A readable dump for a failure message — the request log is usually the half the
	 * screen leaves out (docs/ACCEPTANCE.md). */
	describeTraffic(): string {
		const lines: string[] = [];
		for (const [providerId, count] of [...this.countsByProvider()].sort((a, b) => b[1] - a[1])) {
			lines.push(`  ${providerId ?? '(unrecognised host)'}: ${count}`);
		}
		return lines.join('\n') || '  (no provider requests at all)';
	}

	async install(context: BrowserContext): Promise<void> {
		await context.route('**/*', (route, request) => this.#handle(route, request));
	}

	async #handle(route: Route, request: Request): Promise<void> {
		const url = request.url();
		if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:') || url.startsWith('chrome-error:')) {
			return route.continue();
		}
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return route.continue();
		}
		// The app's own origin: served by the static server, not a provider.
		if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return route.continue();

		const providerId = providerForUrl(url);
		this.requests.push({
			url,
			method: request.method(),
			providerId,
			host: parsed.host,
			atMs: Date.now() - this.#startedAt
		});

		if (this.#options.responseDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, this.#options.responseDelayMs));
		}

		if (providerId !== undefined && this.#options.failing?.includes(providerId)) {
			return route.abort('connectionfailed');
		}

		if (LIVE_MODE && !METERED_HOSTS.has(parsed.host)) {
			// Keyless provider, live mode: let it through and keep the real body, so a
			// changed response shape is visible. Never reached for a metered host.
			const response = await route.fetch();
			const text = await response.text();
			this.bodies.push({ providerId, url, text, recorded: false });
			return route.fulfill({ response, body: text });
		}

		const body = this.#recordedBodyFor(parsed);
		if (body === undefined) {
			this.unrecognised.push(url);
			return route.abort('blockedbyclient');
		}

		const text = JSON.stringify(body);
		this.bodies.push({ providerId, url, text, recorded: true });
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: this.#headersFor(providerId),
			body: text
		});
	}

	#headersFor(providerId: ProviderId | undefined): Record<string, string> {
		const extra = providerId === undefined ? undefined : this.#options.headers?.[providerId];
		if (!extra) return {};
		// A cross-origin response header is invisible to `fetch` unless the server says it
		// may be read. Without this the app could not see these numbers even if it looked
		// for them, and the check would be testing the bench rather than the app.
		return { ...extra, 'access-control-expose-headers': Object.keys(extra).join(', ') };
	}

	#recordedBodyFor(url: URL): unknown {
		const { host, pathname } = url;

		// The two halves of a Ryanair offer since issue #137: prices with no flight identity,
		// and a timetable with no prices. An unanswered `timtbl` leaves every fare unconfirmed
		// and the whole search empty, which is how this bench spent a day answering the
		// endpoint the adapter had stopped calling.
		if (host === RYANAIR_FARES_HOST && pathname.includes('/timtbl/3/schedules')) {
			return recorded.ryanairMonthlySchedule(url);
		}
		if (host === RYANAIR_FARES_HOST && pathname.includes('/oneWayFares')) return recorded.ryanairCheapestPerDay(url);
		if (host === RYANAIR_WEB_HOST && pathname.includes('/airports/en/active')) return recorded.ryanairActiveAirports();
		if (host === AGODA_HOST && pathname.includes('get-prices')) return recorded.agodaGetPrices(url);
		if (host === AGODA_HOST) return recorded.agodaSearch(url);
		if (host === BOOKING_HOST && pathname.includes('getRoomList')) return recorded.bookingRooms(url);
		if (host === BOOKING_HOST) return recorded.bookingSearch(url);
		if (host === KIWI_PUBLIC_HOST) return recorded.kiwiPublicGraphQl(url);
		if (host === NOMINATIM_HOST) return recorded.nominatimReverse();
		// A map style, not a provider answer. Served empty so the detail view's map mounts
		// without reaching a tile CDN, which is neither metered nor interesting here.
		if (UNBUDGETED_HOSTS.includes(host)) return { version: 8, sources: {}, layers: [] };
		if (host === OSRM_HOST) return recorded.osrmRoute();
		if (host === TRANSITOUS_HOST) return recorded.transitousPlan();
		return undefined;
	}
}

/** Keys for every metered provider, so a QA search exercises the full fan-out rather than
 * the reduced keyless one. The values are not credentials and never leave the browser
 * context — the bench answers before a request can go anywhere. */
export const QA_KEYS = {
	agoda: { apiKey: 'qa-not-a-real-key' },
	booking: { apiKey: 'qa-not-a-real-key' }
} as const;

export interface QaFixtures {
	bench: Bench;
	benchOptions: BenchOptions;
	/** Seeds the metered providers' keys before the first navigation. Call it, then
	 * `page.goto` — a key written after a page has loaded is not read again. */
	withKeys: (keys?: Record<string, Record<string, string>>) => Promise<void>;
}

export const test = base.extend<QaFixtures>({
	benchOptions: [{}, { option: true }],

	// `auto` so it installs whether or not a test asks for it. A check that forgets to
	// destructure `bench` would otherwise run with no interception at all — real requests to
	// real providers, and assertions about traffic nobody recorded. That is not hypothetical:
	// it happened once while writing this suite, and the symptom was a currency check quietly
	// passing because the live Ryanair answered differently from the recording.
	bench: [
		async ({ context, benchOptions }, use) => {
			const bench = new Bench(benchOptions);
			await bench.install(context);
			await use(bench);
			// A request to a host no adapter owns is a finding on its own — it means the app is
			// talking to something nobody declared, which is exactly how a cost lands somewhere
			// the budget never looked.
			expect(
				bench.unrecognised,
				`The app called ${bench.unrecognised.length} host(s) the bench does not recognise:\n${bench.unrecognised.map((u) => `  - ${u}`).join('\n')}\n\nAdd it to tests/qa/support/catalog.ts and give it a budget in tests/qa/budget.ts.`
			).toEqual([]);
		},
		{ auto: true }
	],

	withKeys: async ({ context }, use) => {
		await use(async (keys = QA_KEYS as unknown as Record<string, Record<string, string>>) => {
			await context.addInitScript((stored) => {
				window.localStorage.setItem('flights.byokKeys.v1', JSON.stringify(stored));
			}, keys);
		});
	}
});

export { expect };
