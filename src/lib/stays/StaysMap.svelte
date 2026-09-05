<script lang="ts">
	/**
	 * Every candidate stay as a point on a real map, plus the airport all their distances
	 * are measured from. Issue #319: **"there should be a map i can expand with all the
	 * locations, and each point should be clicked to show the hotel info in a sidebar on the
	 * same dialog."**
	 *
	 * ## This file may only ever be rendered inside a dialog
	 *
	 * That is issue #280's rule and it is not a style preference. `tools/probe-map-cost.mjs`
	 * measured Chromium holding sixteen live WebGL contexts and evicting the oldest past
	 * that, in its own words "Too many active WebGL contexts. Oldest context will be lost."
	 * Four MapLibre instances per card settle in 4.5s on a throttled phone, sixteen take
	 * 12.6s with 10.3s of main-thread blocking, and twenty never settle at all. So the
	 * results page carries frozen inline SVG (`RoutePreview`) and exactly one MapLibre
	 * instance exists, only while a dialog is open. `StaysMapDialog` mounts this to open and
	 * unmounts it to close, so the teardown below runs every time.
	 * `stays-map.spec.ts` counts live canvases across ten open-close rounds.
	 *
	 * ## Points, not price pills
	 *
	 * Booking-style price labels are the obvious thing to draw and they are wrong here. A
	 * stopover list runs to about thirty properties in one city, and thirty pills at that
	 * zoom overlap into an unreadable mat - `ItineraryMap` needed sixty lines of collision
	 * lifting for five markers, and that does not scale to thirty. The owner asked for
	 * points whose click opens a sidebar, so the point stays a point and the sidebar carries
	 * every number. The hit target is 24px square with a 12px painted core inside it, which
	 * clears WCAG 2.5.8 without drawing a target that size.
	 *
	 * ## Keyboard
	 *
	 * Each point is a real `<button>` with `aria-pressed`, which is what makes the map
	 * reachable without a pointer at all. The sidebar's own list selects the same points, so
	 * a keyboard reader never has to tab through thirty markers to reach the last one.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { MapLibreMap, Marker as MaplibreMarker } from 'maplibre-gl';
	import type { Coordinates } from '$lib/domain';
	import { boundsOfCoordinates, POINT_VIEW_ZOOM } from '$lib/itinerary-map/geo';
	import { currentColorScheme, MAP_STYLE_URL } from '$lib/itinerary-map/style';
	import { Skeleton } from '$lib/components';
	import type { StayChoice } from './choice';

	interface Props {
		choices: readonly StayChoice[];
		/** Where every distance on every row is measured from, drawn so the points mean
		 * something. Not selectable: it is context, not a stay. */
		airport: { coordinates: Coordinates; iataCode: string; name: string };
		/** `StayChoice.key` of the point whose detail the sidebar is showing, or `null` for
		 * the whole-city view. Bound, because a marker click and a sidebar click both set
		 * it and the two must never disagree about which point is open. */
		selectedKey?: string | null;
		class?: string;
	}

	let { choices, airport, selectedKey = $bindable(null), class: className }: Props = $props();

	let mapContainer = $state<HTMLDivElement>();
	let mapReady = $state(false);

	// Plain handles to the imperative MapLibre world: reassigning these must never itself
	// trigger a Svelte effect. Only the `$state` flag above does that.
	let map: MapLibreMap | undefined;
	let markers: { key: string; element: HTMLElement; marker: MaplibreMarker }[] = [];

	const label = $derived(
		`Map of ${choices.length} ${choices.length === 1 ? 'stay' : 'stays'} near ${airport.name}`
	);

	function prefersReducedMotion(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** The whole city: every property and the airport, which is the view the dialog opens
	 * on and the view Back returns to. The list-and-details pattern is explicit that
	 * leaving a detail must restore the extent the reader came from, or they lose their
	 * place. */
	function fitEverything(animate: boolean): void {
		if (!map) return;
		const [west, south, east, north] = boundsOfCoordinates([
			airport.coordinates,
			...choices.map((choice) => choice.property.coordinates)
		]);
		map.fitBounds(
			[
				[west, south],
				[east, north]
			],
			{ padding: 48, maxZoom: 15, duration: animate && !prefersReducedMotion() ? 600 : 0 }
		);
	}

	function frame(key: string | null, animate: boolean): void {
		if (!map) return;
		if (key === null) {
			fitEverything(animate);
			return;
		}
		const choice = choices.find((candidate) => candidate.key === key);
		if (!choice) return;
		map.flyTo({
			center: [choice.property.coordinates.longitude, choice.property.coordinates.latitude],
			zoom: POINT_VIEW_ZOOM,
			duration: animate && !prefersReducedMotion() ? 600 : 0
		});
	}

	function paintSelection(): void {
		for (const entry of markers) {
			const isSelected = entry.key === selectedKey;
			entry.element.classList.toggle('is-selected', isSelected);
			entry.element.setAttribute('aria-pressed', String(isSelected));
			// A selected point paints over its neighbours rather than under them, so its
			// ring is never clipped by a property a hundred metres away.
			entry.element.style.zIndex = isSelected ? '2' : '';
		}
	}

	async function renderMarkers(instance: MapLibreMap): Promise<void> {
		const { Marker } = await import('maplibre-gl');
		for (const entry of markers) entry.marker.remove();
		markers = [];

		for (const choice of choices) {
			const element = document.createElement('button');
			element.type = 'button';
			element.className = `stay-point${choice.isPicked ? ' is-picked' : ''}`;
			// The name and nothing else. Every number about this property is one click away
			// in the sidebar, and a title attribute is not where a price belongs.
			element.title = choice.property.name;
			element.setAttribute('aria-label', choice.property.name);
			element.setAttribute('aria-pressed', String(choice.key === selectedKey));
			const core = document.createElement('span');
			core.className = 'stay-point-core';
			core.setAttribute('aria-hidden', 'true');
			element.appendChild(core);
			element.addEventListener('click', () => {
				selectedKey = choice.key;
			});
			markers.push({
				key: choice.key,
				element,
				marker: new Marker({ element })
					.setLngLat([choice.property.coordinates.longitude, choice.property.coordinates.latitude])
					.addTo(instance)
			});
		}

		const airportElement = document.createElement('div');
		airportElement.className = 'stay-airport';
		airportElement.setAttribute('role', 'img');
		airportElement.setAttribute('aria-label', `${airport.name} (${airport.iataCode})`);
		airportElement.textContent = airport.iataCode;
		new Marker({ element: airportElement })
			.setLngLat([airport.coordinates.longitude, airport.coordinates.latitude])
			.addTo(instance);

		paintSelection();
	}

	/** The key the camera was last sent to. A plain variable rather than `$state`, so the
	 * effect below writing it is not the effect reading its own dependency - the shape
	 * AGENTS.md records as having frozen every search in production (#87). */
	let framedKey: string | null | undefined;

	// Repainting is cheap and idempotent, so it runs on every pass. Moving the camera is
	// not: `frame` reads `choices`, which is re-derived whenever the picked stay or the
	// stopover's length changes, and without the guard a press of "Use this stay" would
	// yank a traveller's panned view back to a point they were already looking at.
	$effect(() => {
		const key = selectedKey;
		if (!mapReady) return;
		paintSelection();
		if (key === framedKey) return;
		framedKey = key;
		untrack(() => frame(key, true));
	});

	onMount(() => {
		let destroyed = false;
		let schemeQuery: MediaQueryList | undefined;
		let onSchemeChange: (() => void) | undefined;
		let resizeObserver: ResizeObserver | undefined;

		(async () => {
			const maplibregl = await import('maplibre-gl');
			await import('maplibre-gl/dist/maplibre-gl.css');
			// MapLibre v6 cannot locate its tile-parsing worker through a bundler on its own;
			// `?worker&url` asks Vite to emit it as a chunk and hand back that chunk's URL.
			// Without this call every tile silently never parses. `ItineraryMap` says the
			// same at length.
			const { default: workerUrl } = await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url');
			maplibregl.setWorkerUrl(workerUrl);
			if (destroyed || !mapContainer) return;

			const instance = new maplibregl.Map({
				container: mapContainer,
				style: MAP_STYLE_URL[currentColorScheme()],
				center: [airport.coordinates.longitude, airport.coordinates.latitude],
				zoom: 10,
				attributionControl: false,
				dragRotate: false,
				pitchWithRotate: false
			});
			// Required by CARTO's terms for the keyless basemap, same control the itinerary
			// map adds for the same styles.
			instance.addControl(new maplibregl.AttributionControl({ compact: true }));
			instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

			instance.once('load', async () => {
				if (destroyed) return;
				map = instance;
				await renderMarkers(instance);
				framedKey = selectedKey;
				frame(selectedKey, false);
				mapReady = true;
			});

			// Markers are DOM elements rather than style layers, so a style swap leaves them
			// alone and there is nothing to re-add afterwards - unlike the itinerary map,
			// whose line layers go with the old style.
			schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
			onSchemeChange = () => map?.setStyle(MAP_STYLE_URL[currentColorScheme()]);
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
			// The whole reason this component may only live in a dialog. Without this every
			// open would leak a WebGL context and the ninth one would blank the map.
			map?.remove();
			map = undefined;
			mapReady = false;
		};
	});

	onDestroy(() => {
		// Belt and braces for a server render, where `onMount`'s cleanup never runs. Cheap,
		// and the failure it guards against is invisible until the sixteenth context.
		map?.remove();
		map = undefined;
	});
</script>

<div class={['stays-map', className]}>
	<div class="stays-map-canvas" bind:this={mapContainer} role="region" aria-label={label}></div>
	{#if !mapReady}
		<div class="stays-map-loading"><Skeleton height="100%" /></div>
	{/if}
</div>

<style>
	.stays-map {
		position: relative;
		height: 100%;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
	}

	.stays-map-canvas {
		height: 100%;
	}

	.stays-map-loading {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	/* Markers are created imperatively and appended by MapLibre outside this component's
	   subtree, so their rules are global on purpose - the same arrangement `ItineraryMap`
	   uses for its own. */
	:global(.stay-point) {
		display: grid;
		place-items: center;
		/* 24px, the WCAG 2.5.8 minimum, mostly transparent. Painting a target that size
		   would turn thirty properties into thirty overlapping discs. */
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}

	:global(.stay-point-core) {
		width: 12px;
		height: 12px;
		border-radius: var(--radius-full);
		background: var(--color-stopover);
		/* The map's own ground colour, so a point over a dark basemap still reads as a
		   point rather than as a smudge. */
		box-shadow: 0 0 0 2px var(--color-bg-elevated);
		transition:
			width var(--transition-fast),
			height var(--transition-fast);
	}

	:global(.stay-point:hover .stay-point-core),
	:global(.stay-point:focus-visible .stay-point-core) {
		width: 16px;
		height: 16px;
	}

	:global(.stay-point:focus-visible) {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-full);
	}

	/* The stay the itinerary currently books, in the accent every other surface uses for
	   the current pick. Shape as well as colour: a ring, so the distinction survives the
	   greyscale test WCAG 1.4.1 asks for. */
	:global(.stay-point.is-picked .stay-point-core) {
		background: var(--color-accent);
		box-shadow:
			0 0 0 2px var(--color-bg-elevated),
			0 0 0 4px var(--color-accent);
	}

	:global(.stay-point.is-selected .stay-point-core) {
		width: 18px;
		height: 18px;
		box-shadow:
			0 0 0 2px var(--color-bg-elevated),
			0 0 0 4px var(--color-text);
	}

	:global(.stay-airport) {
		padding: 2px 6px;
		border-radius: var(--radius-full);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-strong);
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
	}
</style>
