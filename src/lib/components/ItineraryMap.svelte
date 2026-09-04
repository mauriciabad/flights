<script lang="ts">
	/**
	 * The itinerary map (issue #26): the whole chain drawn on a keyless MapLibre map,
	 * flights as great-circle arcs, everything else as straight hops between known
	 * points (see `$lib/itinerary-map/segments.ts` for why transfers have no real route
	 * shape to draw instead).
	 *
	 * ## The selection contract, for `ItineraryTimeline` (issue #24)
	 *
	 * The whole binding lives in one place: `selectedSegmentId`, a bindable prop typed
	 * `ItinerarySegmentId | null` (from `$lib/itinerary-map/segment-id.ts`, whose own doc
	 * comment confirms its values match `ItineraryTimeline`'s `data-segment` rows
	 * exactly). A parent that renders both components declares one
	 * `$state<ItinerarySegmentId | null>(null)` and binds it to both, e.g.
	 * `bind:selectedSegmentId` on the timeline and again on this component — no other
	 * wiring needed.
	 *
	 * `ItineraryTimeline` (merged in PR #63, after this component's own naming was
	 * already chosen to match) does not yet expose `selectedSegmentId` or a click
	 * handler on its rows — that half of the wiring is still open. Whoever adds it only
	 * needs a couple of lines on each `<li class="tl-row" data-segment={segment}>`: an
	 * `onclick` reading `segment` (already in scope in every row snippet) into the
	 * shared variable, plus a `class:is-selected` (or similar) driven by comparing it
	 * against the incoming prop. No new vocabulary, no translation table.
	 *
	 * Clicking a map marker or flight/transfer line sets the shared variable, which
	 * the timeline should highlight the matching row for; clicking (or otherwise
	 * selecting) a timeline row should set the same variable, which this component
	 * watches to fly/fit the camera to that segment's geometry. Neither side needs to
	 * know how the other renders — there is no lookup table translating a timeline row
	 * into a map feature or back, only the shared id.
	 *
	 * One limitation worth flagging: only markers (real button elements) are
	 * keyboard-reachable on the map side. MapLibre's line layers are canvas-rendered
	 * and pointer-only, so a keyboard user cannot select a flight or transfer leg by
	 * clicking the map itself — they can always do it through the timeline, which
	 * drives this component's view regardless of how the selection was made.
	 */
	import { onDestroy, onMount } from 'svelte';
	import type { GeoJSONSource, MapLibreMap, Marker as MaplibreMarker } from 'maplibre-gl';
	import type { Airport, Itinerary } from '$lib/domain';
	import { getAirport } from '$lib/data/airports';
	import {
		allCoordinates,
		buildItineraryMapModel,
		findSegment,
		type ItineraryMapModel,
		type ItineraryMarkerKind
	} from '$lib/itinerary-map/segments';
	import { viewForCoordinates, type MapView } from '$lib/itinerary-map/geo';
	import type { ItinerarySegmentId } from '$lib/itinerary-map/segment-id';
	import {
		applyThemeColors,
		currentColorScheme,
		ITINERARY_LINE_LAYER_IDS,
		layerIdFor,
		MAP_STYLE_URL,
		SEGMENT_LINE_COLOR,
		type ColorScheme
	} from '$lib/itinerary-map/style';
	import EmptyState from './EmptyState.svelte';
	import Skeleton from './Skeleton.svelte';

	interface Props {
		itinerary: Itinerary;
		selectedSegmentId?: ItinerarySegmentId | null;
		class?: string;
	}

	let { itinerary, selectedSegmentId = $bindable(null), class: className }: Props = $props();

	let mapContainer: HTMLDivElement | undefined = $state();
	let mapReady = $state(false);
	let connectionAirport: Airport | undefined = $state();
	let connectionAirportFailed = $state(false);

	// Plain (non-reactive) handles to the imperative MapLibre world: reassigning these
	// must never itself trigger a Svelte effect, only the `$state` flags above do that.
	let map: MapLibreMap | undefined;
	let markers: { id: ItinerarySegmentId | null; element: HTMLElement; marker: MaplibreMarker }[] = [];
	let previousSelectedId: ItinerarySegmentId | null = null;
	let hasFocusedOnce = false;
	// Tracks whether 'itinerary-lines' currently exists on the map's *active* style —
	// distinct from mapReady, since a colour-scheme change swaps the whole style
	// (map.setStyle) and wipes every custom source/layer along with it.
	let linesSourceAdded = false;

	const model = $derived<ItineraryMapModel | undefined>(
		connectionAirport ? buildItineraryMapModel(itinerary, connectionAirport) : undefined
	);

	const mapAriaLabel = $derived(
		`Route map: ${itinerary.originAirport.city.name} to ${itinerary.destinationAirport.city.name}` +
			(connectionAirport ? ` via ${connectionAirport.city.name}` : '')
	);

	const announcement = $derived.by(() => {
		if (!model) return '';
		if (!selectedSegmentId) return 'Showing the whole route.';
		const segment = findSegment(model, selectedSegmentId);
		return segment ? `Showing ${segment.label}.` : '';
	});

	// Resolves the one thing an Itinerary never names directly (see segments.ts's own
	// doc comment). Re-runs if the itinerary prop itself is swapped out from above
	// (e.g. a future comparator flipping between candidate itineraries).
	$effect(() => {
		const arrivalCode = itinerary.outboundFlight.arrivalAirport;
		let cancelled = false;
		connectionAirportFailed = false;
		getAirport(arrivalCode).then((airport) => {
			if (cancelled) return;
			if (!airport) {
				connectionAirportFailed = true;
				return;
			}
			connectionAirport = airport;
		});
		return () => {
			cancelled = true;
		};
	});

	function prefersReducedMotion(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function applyView(view: MapView, animate: boolean): void {
		if (!map) return;
		const duration = animate && !prefersReducedMotion() ? 700 : 0;
		if (view.kind === 'bounds') {
			const [west, south, east, north] = view.bounds;
			map.fitBounds(
				[
					[west, south],
					[east, north]
				],
				{ padding: 56, maxZoom: 15, duration }
			);
		} else {
			map.flyTo({ center: view.center as [number, number], zoom: view.zoom, duration });
		}
	}

	function focusSegment(currentModel: ItineraryMapModel, id: ItinerarySegmentId | null, animate: boolean): void {
		if (id === null) {
			applyView(viewForCoordinates(allCoordinates(currentModel)), animate);
			return;
		}
		const segment = findSegment(currentModel, id);
		// A stale id from an itinerary that just changed underneath the selection —
		// nothing to focus, and the caller (the future timeline) owns clearing it.
		if (!segment) return;
		const coordinates = segment.kind === 'point' ? [segment.coordinates] : segment.coordinates;
		applyView(viewForCoordinates(coordinates), animate);
	}

	/**
	 * Issue #118: the owner's complaint was literally "markers for start hotel and end"
	 * being indistinguishable from an airport — so these three get a compact icon glyph
	 * inside a plain circle (`.itinerary-marker-pin` below), rather than the airport
	 * pill's elongated shape and IATA-code text. Static, hand-rolled markup rather than
	 * an icon-library import: this codebase already draws its few icons this way
	 * (`EmptyState.svelte`, `Chip.svelte`) with no icon dependency at all, and three more
	 * glyphs isn't reason enough to add one. `currentColor` picks up the tone colour
	 * `.itinerary-marker-pin`'s CSS sets, exactly like those two components' own icons.
	 */
	const MARKER_ICONS: Record<Exclude<ItineraryMarkerKind, 'airport'>, string> = {
		// A simple house/roofline: the trip's own starting point.
		start: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 8 3l5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M4.5 7.5V13a.8.8 0 0 0 .8.8h5.4a.8.8 0 0 0 .8-.8V7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
		// A bed: where the free time in the connection city is actually spent.
		stay: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13V5.5A1.5 1.5 0 0 1 3.5 4H6a1.5 1.5 0 0 1 1.5 1.5V8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M2 9h11a1.5 1.5 0 0 1 1.5 1.5V13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M2 13v-1.2M14 13v-1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
		// A flag: the trip's final destination.
		end: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 3h8l-2.5 2.5L12 8H4" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>`
	};

	function shortLabelFor(label: string): string {
		// Airports show their IATA code (the label's own "(XYZ)" suffix); the hotel and
		// any origin/destination location show no on-map text at all, just the dot —
		// their full name lives in the aria-label/title instead of squeezed next to a
		// marker where it would overlap its neighbours.
		const match = /\(([A-Z]{3})\)$/.exec(label);
		return match ? match[1] : '';
	}

	function updateMarkerSelection(): void {
		for (const entry of markers) {
			const isSelected = entry.id !== null && entry.id === selectedSegmentId;
			entry.element.classList.toggle('is-selected', isSelected);
			if (entry.id !== null) entry.element.setAttribute('aria-pressed', String(isSelected));
		}
	}

	async function renderMarkers(currentModel: ItineraryMapModel): Promise<void> {
		if (!map) return;
		const { Marker } = await import('maplibre-gl');

		for (const entry of markers) entry.marker.remove();
		markers = [];

		const waypoints: {
			id: ItinerarySegmentId | null;
			coordinates: Airport['coordinates'];
			label: string;
			tone: 'neutral' | 'stopover';
			markerKind: ItineraryMarkerKind;
		}[] = [];
		for (const segment of currentModel.segments) {
			if (segment.kind !== 'point') continue;
			waypoints.push({
				id: segment.id,
				coordinates: segment.coordinates,
				label: segment.label,
				tone: segment.tone,
				markerKind: segment.markerKind
			});
		}
		for (const waypoint of currentModel.extraWaypoints) {
			waypoints.push({
				id: null,
				coordinates: waypoint.coordinates,
				label: waypoint.label,
				tone: waypoint.tone,
				markerKind: waypoint.markerKind
			});
		}

		for (const point of waypoints) {
			const isSelectable = point.id !== null;
			const markerKind = point.markerKind;
			const el = document.createElement(isSelectable ? 'button' : 'div');
			el.className =
				markerKind === 'airport'
					? `itinerary-marker itinerary-marker-${point.tone}`
					: `itinerary-marker itinerary-marker-pin itinerary-marker-${point.tone}`;
			el.title = point.label;
			el.setAttribute('aria-label', point.label);
			if (isSelectable) {
				(el as HTMLButtonElement).type = 'button';
				el.setAttribute('aria-pressed', String(selectedSegmentId === point.id));
				el.addEventListener('click', () => {
					selectedSegmentId = point.id;
				});
			} else {
				// Drawn for context (the destination airport — see segment-id.ts) but not
				// itself a control: a screen reader still gets the name via `role="img"`,
				// it just isn't announced as something the user can activate.
				el.setAttribute('role', 'img');
			}

			if (markerKind === 'airport') {
				const dot = document.createElement('span');
				dot.className = 'itinerary-marker-dot';
				dot.setAttribute('aria-hidden', 'true');
				el.appendChild(dot);

				const short = shortLabelFor(point.label);
				if (short) {
					const shortLabelEl = document.createElement('span');
					shortLabelEl.className = 'itinerary-marker-code font-mono tabular-nums';
					shortLabelEl.textContent = short;
					shortLabelEl.setAttribute('aria-hidden', 'true');
					el.appendChild(shortLabelEl);
				}
			} else {
				// Issue #118: a distinct icon glyph, not a plain dot, so the start point, the
				// hotel and the end point read as what they are rather than as another
				// airport. Static markup from MARKER_ICONS, never interpolated user data.
				const iconWrap = document.createElement('span');
				iconWrap.className = 'itinerary-marker-icon';
				iconWrap.setAttribute('aria-hidden', 'true');
				iconWrap.innerHTML = MARKER_ICONS[markerKind];
				el.appendChild(iconWrap);
			}

			const marker = new Marker({ element: el, anchor: 'bottom' })
				.setLngLat([point.coordinates.longitude, point.coordinates.latitude])
				.addTo(map);

			markers.push({ id: point.id, element: el, marker });
		}
	}

	function addLineLayers(currentMap: MapLibreMap, scheme: ColorScheme): void {
		const colors = SEGMENT_LINE_COLOR[scheme];

		for (const tone of ['neutral', 'stopover'] as const) {
			currentMap.addLayer({
				id: layerIdFor('flight', tone),
				type: 'line',
				source: 'itinerary-lines',
				filter: ['all', ['==', ['get', 'role'], 'flight'], ['==', ['get', 'tone'], tone]],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': colors[tone],
					'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 5, 3],
					'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.85]
				}
			});

			currentMap.addLayer({
				id: layerIdFor('transfer', tone),
				type: 'line',
				source: 'itinerary-lines',
				filter: ['all', ['==', ['get', 'role'], 'transfer'], ['==', ['get', 'tone'], tone]],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': colors[tone],
					'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 4, 2],
					'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.65],
					'line-dasharray': [2, 1.6]
				}
			});
		}

		for (const layerId of ITINERARY_LINE_LAYER_IDS) {
			currentMap.on('click', layerId, (event) => {
				const raw = event.features?.[0]?.properties?.segmentId;
				if (typeof raw === 'string') selectedSegmentId = raw as ItinerarySegmentId;
			});
			currentMap.on('mouseenter', layerId, () => {
				currentMap.getCanvas().style.cursor = 'pointer';
			});
			currentMap.on('mouseleave', layerId, () => {
				currentMap.getCanvas().style.cursor = '';
			});
		}
	}

	function renderModel(currentModel: ItineraryMapModel): void {
		if (!map) return;

		const lineFeatures = currentModel.segments
			.filter((segment) => segment.kind === 'line')
			.map((segment) => ({
				type: 'Feature' as const,
				id: segment.id,
				properties: { segmentId: segment.id, role: segment.role, tone: segment.tone },
				geometry: {
					type: 'LineString' as const,
					coordinates: segment.coordinates.map((c) => [c.longitude, c.latitude])
				}
			}));
		const lineData = { type: 'FeatureCollection' as const, features: lineFeatures };

		if (linesSourceAdded) {
			// Known to be a GeoJSONSource: this module is the only code that ever adds
			// a source under this id, always as `{ type: 'geojson' }` below.
			const source = map.getSource('itinerary-lines') as GeoJSONSource | undefined;
			source?.setData(lineData);
		} else {
			map.addSource('itinerary-lines', { type: 'geojson', data: lineData });
			addLineLayers(map, currentColorScheme());
			linesSourceAdded = true;
		}

		void renderMarkers(currentModel);
	}

	function applySelectionState(currentModel: ItineraryMapModel, id: ItinerarySegmentId | null): void {
		if (!map) return;
		if (previousSelectedId && previousSelectedId !== id) {
			try {
				map.setFeatureState({ source: 'itinerary-lines', id: previousSelectedId }, { selected: false });
			} catch {
				// Source not ready yet — nothing was highlighted, so nothing to clear.
			}
		}
		if (id) {
			try {
				map.setFeatureState({ source: 'itinerary-lines', id }, { selected: true });
			} catch {
				// Source not ready yet; the next model render will pick up the state
				// once `applySelectionState` re-runs after it.
			}
		}
		previousSelectedId = id;
		updateMarkerSelection();
	}

	// Effect 1: (re)builds the map's sources/layers/markers whenever the itinerary
	// resolves or changes. Declared before effect 2 so a first-time model is on the
	// map before that effect tries to select or focus anything in it.
	$effect(() => {
		const currentModel = model;
		if (!mapReady || !currentModel) return;
		renderModel(currentModel);
	});

	// Effect 2: selection <-> camera. Reruns on every selectedSegmentId change (from a
	// marker click here or, once bound, a timeline row elsewhere) and whenever the
	// model itself changes, so a rebuilt itinerary reapplies the current selection
	// against its new geometry instead of quietly going stale.
	$effect(() => {
		const id = selectedSegmentId;
		const currentModel = model;
		if (!mapReady || !currentModel) return;
		applySelectionState(currentModel, id);
		focusSegment(currentModel, id, hasFocusedOnce);
		hasFocusedOnce = true;
	});

	onMount(() => {
		let destroyed = false;
		let schemeQuery: MediaQueryList | undefined;
		let onSchemeChange: (() => void) | undefined;
		let resizeObserver: ResizeObserver | undefined;

		(async () => {
			const maplibregl = await import('maplibre-gl');
			await import('maplibre-gl/dist/maplibre-gl.css');
			// MapLibre v6 offloads vector-tile parsing to a Web Worker but, unlike a
			// plain browser <script type="module">, cannot locate that worker's file
			// through a bundler on its own (see the v5->v6 migration guide's "
			// setWorkerUrl() is bundler-only" note). The `?worker&url` suffix asks Vite
			// to emit the worker as its own chunk and hand back that chunk's URL, which
			// is what actually makes the map render tile data instead of a blank
			// background — without this call every tile silently never parses.
			const { default: workerUrl } = await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url');
			maplibregl.setWorkerUrl(workerUrl);
			if (destroyed || !mapContainer) return;

			const scheme = currentColorScheme();
			const instance = new maplibregl.Map({
				container: mapContainer,
				style: MAP_STYLE_URL[scheme],
				center: [10, 45],
				zoom: 2,
				attributionControl: false,
				dragRotate: false,
				pitchWithRotate: false
			});
			instance.addControl(new maplibregl.AttributionControl({ compact: true }));
			instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

			instance.once('load', () => {
				applyThemeColors(instance, scheme);
				map = instance;
				mapReady = true;
			});

			schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
			onSchemeChange = () => {
				if (!map) return;
				const newScheme = currentColorScheme();
				map.setStyle(MAP_STYLE_URL[newScheme]);
				// setStyle wipes every custom source/layer along with the old style, so the
				// next renderModel() must re-add them rather than call setData() on a
				// source that no longer exists.
				linesSourceAdded = false;
				map.once('style.load', () => {
					if (!map) return;
					// Base layers (background/water) exist as soon as the style loads;
					// the itinerary line layers don't until renderModel() re-adds them
					// below, so this call first only ever recolours the base ones —
					// itself harmless, and the second call after renderModel() covers
					// the rest once they exist.
					applyThemeColors(map, newScheme);
					const currentModel = model;
					if (currentModel) {
						renderModel(currentModel);
						applyThemeColors(map, newScheme);
						applySelectionState(currentModel, selectedSegmentId);
					}
				});
			};
			schemeQuery.addEventListener('change', onSchemeChange);

			resizeObserver = new ResizeObserver(() => map?.resize());
			resizeObserver.observe(mapContainer);
		})();

		return () => {
			destroyed = true;
			if (schemeQuery && onSchemeChange) schemeQuery.removeEventListener('change', onSchemeChange);
			resizeObserver?.disconnect();
			for (const entry of markers) entry.marker.remove();
			markers = [];
			map?.remove();
			map = undefined;
			mapReady = false;
		};
	});

	onDestroy(() => {
		map?.remove();
	});
</script>

<div class={['itinerary-map', className]}>
	<div class="itinerary-map-canvas" bind:this={mapContainer} role="region" aria-label={mapAriaLabel}>
		{#if !mapReady}
			<div class="itinerary-map-loading" aria-hidden="true">
				<Skeleton width="100%" height="100%" radius="var(--radius-lg)" />
			</div>
		{:else if connectionAirportFailed}
			<div class="itinerary-map-overlay">
				<EmptyState
					title="Route map incomplete"
					description={`No coordinates found for ${itinerary.outboundFlight.arrivalAirport}, so the connection can't be drawn.`}
				/>
			</div>
		{/if}
	</div>
	<div class="itinerary-map-legend" aria-hidden="true">
		<span class="legend-item"><span class="legend-dot legend-dot-neutral"></span>Your route</span>
		<span class="legend-item"><span class="legend-dot legend-dot-stopover"></span>The free city</span>
	</div>
	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.itinerary-map {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.itinerary-map-canvas {
		position: relative;
		width: 100%;
		/* Tall enough to read as a real map, short enough that it never dominates a
		   320px-wide screen; clamp keeps both ends honest instead of a fixed height
		   that would either crop the map or leave it comically short. */
		height: clamp(240px, 60vw, 420px);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		overflow: hidden;
		background: var(--color-bg-inset);
	}

	/* MapLibre injects its own canvas/controls as children of this element; the two
	   rules below only touch layout it doesn't already own. */
	.itinerary-map-canvas :global(.maplibregl-map) {
		width: 100%;
		height: 100%;
		font-family: var(--font-sans);
	}

	/* MapLibre's default control buttons are ~29px, under the 44px touch target this
	   app otherwise guarantees everywhere else. Full WCAG compliance would mean
	   replacing the controls outright; this closes most of the gap for a control
	   that is a convenience (pinch-zoom and scroll-zoom both still work) rather than
	   the only way to do anything on the map. */
	.itinerary-map-canvas :global(.maplibregl-ctrl-group button) {
		width: 2.25rem;
		height: 2.25rem;
	}

	.itinerary-map-loading,
	.itinerary-map-overlay {
		position: absolute;
		inset: 0;
	}

	.itinerary-map-overlay {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-inset);
	}

	.itinerary-map-legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.legend-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
	}

	.legend-dot-neutral {
		background: var(--color-accent);
	}

	.legend-dot-stopover {
		background: var(--color-stopover);
	}

	/* Marker DOM, built imperatively in the script block since MapLibre positions this
	   element itself — see renderMarkers(). Uses var(--color-*) directly (unlike the
	   canvas-rendered lines in style.ts) so it stays in sync with the palette for
	   free, in both colour schemes, with no JS re-paint needed. */
	:global(.itinerary-marker) {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		border: none;
		border-radius: var(--radius-full);
		background: var(--color-bg-elevated);
		box-shadow: var(--shadow-sm);
		color: var(--color-text);
		cursor: pointer;
		transition:
			transform var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	:global(div.itinerary-marker) {
		cursor: default;
	}

	:global(.itinerary-marker-dot) {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
		flex-shrink: 0;
	}

	:global(.itinerary-marker-neutral .itinerary-marker-dot) {
		background: var(--color-accent);
	}

	:global(.itinerary-marker-stopover .itinerary-marker-dot) {
		background: var(--color-stopover);
	}

	:global(.itinerary-marker-code) {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
	}

	/* Issue #118: start/hotel/end markers, deliberately a different silhouette from an
	   airport's elongated, text-bearing pill above — a plain circle with an icon and no
	   label, so the two kinds of marker are never mistaken for each other even at a
	   glance. Same background/shadow/hover language as `.itinerary-marker` itself
	   (inherited, unmodified), only the shape and the dot-vs-icon content change. */
	:global(.itinerary-marker-pin) {
		gap: 0;
		padding: var(--space-2);
		border-radius: var(--radius-full);
		aspect-ratio: 1;
	}

	:global(.itinerary-marker-icon) {
		display: flex;
		width: 1rem;
		height: 1rem;
	}

	:global(.itinerary-marker-icon svg) {
		width: 100%;
		height: 100%;
	}

	:global(.itinerary-marker-pin.itinerary-marker-neutral .itinerary-marker-icon) {
		color: var(--color-accent);
	}

	:global(.itinerary-marker-pin.itinerary-marker-stopover .itinerary-marker-icon) {
		color: var(--color-stopover);
	}

	:global(button.itinerary-marker:hover),
	:global(button.itinerary-marker:focus-visible) {
		transform: translateY(-1px) scale(1.05);
	}

	:global(.itinerary-marker.is-selected) {
		box-shadow: var(--shadow-accent);
		transform: scale(1.15);
	}

	:global(.itinerary-marker-stopover.is-selected) {
		box-shadow: 0 6px 20px rgb(45 212 191 / 30%);
	}
</style>
