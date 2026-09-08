/**
 * Drives issue #441's lightbox in a real browser and reports what it actually did.
 *
 * `pnpm check` and a jsdom test cannot see this feature at all. jsdom runs no layout, so
 * every rectangle is 0x0, and an assertion about a transform passes just as happily against
 * a lightbox that cannot zoom. AGENTS.md names that gap by example: `TripStrip` shipped to
 * production 2px wide with five green e2e tests over it.
 *
 * So this launches its OWN Chromium, never the shared Playwright MCP browser, which other
 * agents retarget between tool calls.
 *
 * ## What it mounts, and why not the results page
 *
 * A temporary SvelteKit route holding one `PhotoCarousel`, written before the run and
 * deleted after it. Driving the real results page would need the whole provider bench
 * mocked, and a probe that answers its own mocks is the trap AGENTS.md's "Mocks belong to a
 * test" section is about.
 *
 * Nothing here intercepts a request. The photographs come from this probe's own little image
 * server, which is an origin rather than an answer to somebody else's, the same shape
 * `probe-images.mjs` and `probe-map-cost.mjs` use. `guard.spec.ts` fails the suite for any
 * probe that can `route()` or `fulfill`, and it is right to: an instrument that can serve a
 * fixture cannot be trusted to detect one.
 *
 * What that costs is one claim. The lightbox swaps in the publisher's original once the
 * reader zooms past 1x, and `originalStayPhoto` only reverses addresses on a provider's own
 * host, so it cannot fire for a photograph this probe serves. That wiring is pinned in
 * `src/lib/stays/PhotoCarousel.test.ts` instead, which can assert the element and its `src`
 * without anybody's network. Everything a browser alone can answer is measured here.
 *
 * Usage: node tools/probe-photo-lightbox.mjs [--headed]
 * Screenshots land in docs/screenshots/441-lightbox-*.png, named the way this repo names
 * every other one: issue, subject, colour scheme, viewport width.
 */
import { chromium } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { newProbeContext } from './probe-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const routeDir = path.join(repo, 'src', 'routes', 'probe-photo-lightbox');
const shots = path.join(repo, 'docs', 'screenshots');
const headed = process.argv.includes('--headed');
/** The trailing slash matters: this app redirects 308 without it, and a probe that followed
 * that redirect would measure a page it did not mean to load. */
const ROUTE = '/probe-photo-lightbox/';

/** A port the OS just told us is free, rather than a number picked in advance.
 * AGENTS.md: a dozen worktrees on this machine pick ports independently, and a run that
 * attaches to somebody else's server measures somebody else's branch. */
async function freePort() {
	if (process.env.PROBE_PORT) return Number(process.env.PROBE_PORT);
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** A real image with real intrinsic dimensions and no binary to check in. An `<img>` decodes
 * an SVG like any other format, so the drawn rectangle and therefore the pan limits are the
 * ones a photograph would produce. 800x500 is the card width `hostelworld-photo.ts` asks
 * Cloudinary for. */
function svg(label) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="100%" height="100%" fill="#264653"/><g fill="#f4f6fb" font-family="monospace"><text x="40" y="120" font-size="72">${label}</text><text x="40" y="210" font-size="44">800x500</text></g><circle cx="680" cy="380" r="60" fill="#e8a33d"/></svg>`;
}

/** Serves the four photographs from an origin of this probe's own, so the page fetches real
 * bytes over a real socket and nothing has to intercept anything. */
async function startImageServer() {
	const requested = [];
	const server = createServer((request, response) => {
		requested.push(request.url);
		response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
		response.end(svg(`PHOTO ${request.url.replace(/\D/g, '')}`));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { origin: `http://127.0.0.1:${server.address().port}`, requested, server };
}

const pageSource = (photo) => `<script lang="ts">
	import { PhotoCarousel, stayPhotos } from '$lib/stays';

	const property = {
		name: 'Probe Hostel London',
		coordinates: { latitude: 51.49, longitude: -0.09 },
		images: ['${photo(1)}', '${photo(2)}'],
		rating: { value: 88, outOf: 100 }
	};
	const stay = {
		property,
		roomKind: 'female-dorm',
		pricePerNight: { minorUnits: 1907, currency: 'EUR' },
		roomImages: ['${photo(3)}', '${photo(4)}']
	};
	const photos = stayPhotos(property, [stay]);
</script>

<main>
	<div class="probe-card">
		<PhotoCarousel {photos} name={property.name} />
	</div>
</main>

<style>
	main {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: 2rem;
		background: var(--color-bg);
	}

	.probe-card {
		width: min(24rem, 100%);
	}
</style>
`;

let vite;

async function main() {
	await mkdir(routeDir, { recursive: true });
	await mkdir(shots, { recursive: true });
	const images = await startImageServer();
	const photo = (n) => `${images.origin}/photo-${n}.svg`;
	await writeFile(path.join(routeDir, '+page.svelte'), pageSource(photo));

	const port = await freePort();
	vite = spawn('pnpm', ['exec', 'vite', 'dev', '--port', String(port), '--strictPort'], {
		cwd: repo,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// `localhost` rather than `127.0.0.1`: vite binds the loopback name, which on this
	// machine resolves to ::1 first, and a probe pointed at the v4 address is refused.
	const origin = `http://localhost:${port}`;
	vite.stdout.on('data', () => {});
	vite.stderr.on('data', (chunk) => process.stderr.write(chunk));
	// Polled rather than read off stdout. Vite prints "ready in" before the route is
	// answerable, and a probe that raced it reported a connection refused as a broken page.
	const deadline = Date.now() + 90_000;
	for (;;) {
		try {
			const response = await fetch(`${origin}${ROUTE}`);
			if (response.ok) break;
		} catch {
			if (Date.now() > deadline) throw new Error('vite did not answer in 90s');
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	const browser = await chromium.launch({ headless: !headed });
	// Dark by default, because the app is dark-first around #0b1020 and a run that only ever
	// screenshotted light mode would be checking the half nobody sees first.
	const context = await newProbeContext(browser, {
		viewport: { width: 1100, height: 800 },
		colorScheme: 'dark'
	});
	const page = await context.newPage();

	const consoleErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(String(error)));

	const report = {};
	await page.goto(`${origin}${ROUTE}`, { waitUntil: 'networkidle' });

	const carousel = page.locator('.photo-carousel');
	await carousel.waitFor();
	// One, and that is the point: `PhotoCarousel` gives a `src` only to photographs the reader
	// has actually reached, which is issue #284's saving.
	report.stripImagesWithSrc = await page.locator('.photo-strip img').count();
	// Issue #284's saving, counted rather than trusted. One, because `PhotoCarousel` gives a
	// `src` only to photographs the reader has actually reached.
	report.photosFetchedByTheCard = [...new Set(images.requested)].length;
	report.roomBadgeOnFirst = await page.locator('.photo-subject').count();

	// The picture itself is the target, which is what the issue asked for.
	await carousel.locator('img').first().click();
	const dialog = page.locator('dialog.photo-lightbox');
	await dialog.waitFor();
	report.opened = await dialog.evaluate((el) => el.open);
	report.caption = (await page.locator('.lightbox-caption').innerText()).replace(/\s+/g, ' ');
	report.thumbs = await page.locator('.lightbox-thumb').count();
	// Chrome focuses the dialog element itself unless something inside claims it, and a focused
	// dialog wears this app's accent ring around the whole viewport the moment a key is
	// pressed. So the answer here has to be a control, not `DIALOG`.
	report.focusOnOpen = await page.evaluate(() =>
		`${document.activeElement?.tagName} ${document.activeElement?.className ?? ''}`.trim()
	);
	await page.screenshot({ path: path.join(shots, '441-lightbox-open-dark-1100.png') });

	const stage = page.locator('.lightbox-stage');
	const box = await stage.boundingBox();
	report.stage = { width: Math.round(box.width), height: Math.round(box.height) };
	const readScale = () =>
		page.locator('.lightbox-frame').evaluate((el) => {
			const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
			return { scale: Number(matrix.a.toFixed(4)), x: Math.round(matrix.e), y: Math.round(matrix.f) };
		});
	report.atRest = await readScale();

	// A plain mouse wheel, off-centre. Off-centre is the whole test: a zoom anchored to the
	// middle leaves the translation at 0 and this run would not notice.
	const offCentre = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 };
	await page.mouse.move(offCentre.x, offCentre.y);
	await page.mouse.wheel(0, -400);
	await page.waitForTimeout(150);
	report.afterWheel = await readScale();

	// The trackpad pinch, which reaches a page as a wheel carrying ctrlKey. `mouse.wheel`
	// cannot set that flag, so the event is dispatched directly, and `cancelable` plus the
	// returned `defaultPrevented` is what proves the handler stopped the browser page-zoom.
	report.pinchPrevented = await stage.evaluate((el, point) => {
		const event = new WheelEvent('wheel', {
			deltaY: -60,
			ctrlKey: true,
			clientX: point.x,
			clientY: point.y,
			bubbles: true,
			cancelable: true
		});
		el.dispatchEvent(event);
		return event.defaultPrevented;
	}, offCentre);
	await page.waitForTimeout(150);
	report.afterPinch = await readScale();
	await page.screenshot({ path: path.join(shots, '441-lightbox-zoomed-dark-1100.png') });

	// Drag while zoomed.
	await page.mouse.move(offCentre.x, offCentre.y);
	await page.mouse.down();
	await page.mouse.move(offCentre.x + 120, offCentre.y + 60, { steps: 6 });
	await page.mouse.up();
	await page.waitForTimeout(150);
	report.afterDrag = await readScale();

	// Keyboard paging, which also has to drop the zoom.
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	report.afterArrowRight = {
		counter: (await page.locator('.lightbox-count').innerText()).replace(/\s+/g, ' '),
		...(await readScale())
	};
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	report.onRoomPhoto = {
		caption: (await page.locator('.lightbox-caption').innerText()).replace(/\s+/g, ' '),
		subject: await page.locator('.lightbox-subject').innerText()
	};
	report.afterKeyboard = await page.evaluate(() => {
		const dialog = document.querySelector('dialog.photo-lightbox');
		const style = getComputedStyle(dialog);
		return {
			active: `${document.activeElement?.tagName} ${document.activeElement?.className ?? ''}`.trim(),
			dialogOutline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
			dialogBorder: `${style.borderTopStyle} ${style.borderTopWidth} ${style.borderTopColor}`,
			dialogMatchesFocusVisible: dialog.matches(':focus-visible')
		};
	});
	await page.screenshot({ path: path.join(shots, '441-lightbox-room-dark-1100.png') });

	// Light mode, since the app has to work both ways round.
	await page.emulateMedia({ colorScheme: 'light' });
	await page.waitForTimeout(150);
	await page.screenshot({ path: path.join(shots, '441-lightbox-room-light-1100.png') });
	await page.emulateMedia({ colorScheme: null });

	// A phone, where the strip and the picture have to share 780px of height.
	await page.setViewportSize({ width: 375, height: 780 });
	await page.waitForTimeout(200);
	const phoneStage = await stage.boundingBox();
	report.phoneStage = { width: Math.round(phoneStage.width), height: Math.round(phoneStage.height) };
	report.phoneBodyOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	await page.screenshot({ path: path.join(shots, '441-lightbox-room-dark-375.png') });

	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	report.closed = (await page.locator('dialog.photo-lightbox').count()) === 0;
	report.focusReturned = await page.evaluate(() =>
		document.activeElement?.closest('.photo-carousel')
			? document.activeElement.className || 'inside the carousel'
			: 'lost to the document body'
	);
	// `/sw.js` 404s under `vite dev` because the service worker is only built for production.
	// Reporting it every run would train a reader to skim this list.
	report.consoleErrors = consoleErrors.filter((line) => !line.includes('(404)'));

	console.log(JSON.stringify(report, null, 2));

	// Four, and deliberately: the strip along the bottom of the lightbox is the reader asking
	// to see the others. `PhotoLightbox`'s header argues why that is where the gate ends.
	report.photosFetchedByTheLightbox = [...new Set(images.requested)].length;

	await browser.close();
	images.server.close();
}

try {
	await main();
} finally {
	// Both, always. AGENTS.md counted fourteen dev servers left listening on this machine one
	// morning, every one of them a port a later run can silently attach to.
	vite?.kill('SIGTERM');
	await rm(routeDir, { recursive: true, force: true });
}
