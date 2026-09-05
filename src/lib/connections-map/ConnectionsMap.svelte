<script lang="ts">
	/**
	 * Every connection this search considered, drawn as two great-circle arcs each over one
	 * dashed baseline (issue #324).
	 *
	 * ## This file may only ever be rendered inside a dialog
	 *
	 * Issue #280's rule, and not a style preference. `tools/probe-map-cost.mjs` measured
	 * Chromium holding sixteen live WebGL contexts and evicting the oldest past that, in its
	 * own words "Too many active WebGL contexts. Oldest context will be lost." Four MapLibre
	 * instances per card settle in 4.5s on a throttled phone and twenty never settle at all.
	 * So the results page carries frozen inline SVG (`RoutePreview`) and exactly one MapLibre
	 * instance exists, only while a dialog is open. `ConnectionsMapDialog` mounts this to open
	 * and unmounts it to close, so the teardown below runs every time, and
	 * `connections-map.spec.ts` counts live canvases across ten open-close rounds.
	 *
	 * ## The dashed arc is not a flight
	 *
	 * The thin dashed line between the two end airports is the shortest line that exists
	 * between them. No carrier flies it, nothing quoted a fare for it, and no itinerary on
	 * this map contains it. `FlightDetour` draws the same line on the card for the same
	 * reason and captions it in words; here the legend does. This app spent a night removing
	 * map lines that implied routes it did not have, and a baseline silently promoted to "a
	 * flight" would put one straight back.
	 *
	 * ## Colour is never the only channel
	 *
	 * A refused connection is drawn dashed as well as dimmed, and a pending one is drawn as a
	 * ring with no fill. WCAG 1.4.1: the four states survive a greyscale print, and every one
	 * of them is also written in words in the panel and in each point's accessible name.
	 *
	 * ## Hover previews, focus previews, click pins
	 *
	 * The owner asked for a tooltip that vanishes when the pointer moves onto it, so he can
	 * sweep across close-together points and watch it change. There is no tooltip: pointing
	 * at a point updates the panel beside the map, which never sits under the pointer and so
	 * never has to vanish. `ConnectionsMapDialog`'s own comment argues that out against WCAG
	 * 1.4.13 in full. What this file owes that arrangement is the events: `pointerenter` and
	 * `focus` preview, `pointerleave` and `blur` stop previewing, and a click or Enter pins.
	 * Each point is a real `<button>`, so the whole map is reachable with no pointer at all.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { GeoJSONSource, MapLibreMap, Marker as MaplibreMarker } from 'maplibre-gl';
	import type { Coordinates, IataAirportCode } from '$lib/domain';
	import { boundsOfCoordinates } from '$lib/itinerary-map/geo';
	import { currentColorScheme, MAP_STYLE_URL } from '$lib/itinerary-map/style';
	import { Skeleton } from '$lib/components';
	import { pointLabel } from './copy';
	import type { ConnectionOnMap, ConnectionsMapModel } from './model';

	interface Props {
		model: ConnectionsMapModel;
		/** IATA code of the connection the panel is showing, or `null` for the whole picture.
		 * Bound: a point and a panel row both write it, and the two must never disagree. */
		shownCode?: IataAirportCode | null;
		/** The code a click pinned, drawn with a heavier ring than a mere preview so a
		 * traveller sweeping the map can still see where they left their marker. */
		pinnedCode?: IataAirportCode | null;
		/** Price labels by airport code, for the point tooltips. The map does not format
		 * money; the dialog hands it the strings it already built for the panel. */
		priceLabels?: Readonly<Partial<Record<IataAirportCode, string>>>;
		onpreview: (code: IataAirportCode | null) => void;
		onpin: (code: IataAirportCode) => void;
	}

	let {
		model,
		shownCode = null,
		pinnedCode = null,
		priceLabels = {},
		onpreview,
		onpin
	}: Props = $props();

	let mapContainer = $state<HTMLDivElement>();
	let mapReady = $state(false);

	// Plain handles to the imperative MapLibre world: reassigning these must never itself
	// trigger a Svelte effect. Only the `$state` flag above does that.
	let map: MapLibreMap | undefined;
	let markers: { code: IataAirportCode; element: HTMLElement; marker: MaplibreMarker }[] = [];
	let endMarkers: MaplibreMarker[] = [];
	let linesAdded = false;

	const label = $derived(
		`Map of ${model.connections.length} connection ${model.connections.length === 1 ? 'airport' : 'airports'} ` +
			`between ${model.originAirport.city.name} and ${model.destinationAirport.city.name}`
	);

	function prefersReducedMotion(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** Colours as plain hex, because MapLibre paint properties are WebGL uniforms and cannot
	 * read a CSS custom property. Mirrors `--color-stopover`, `--color-accent`,
	 * `--color-text-faint` and `--color-text-muted` from `src/app.css` per scheme, the same
	 * duplication `itinerary-map/style.ts` documents and accepts for the same reason. */
	const LINE_COLOR = {
		dark: { bookable: '#2dd4bf', 'part-priced': '#e8a33d', blocked: '#7681a3', pending: '#7681a3', baseline: '#7681a3' },
		light: { bookable: '#0f766e', 'part-priced': '#8a5407', blocked: '#626a91', pending: '#626a91', baseline: '#626a91' }
	} as const;

	function lineFeatures() {
		const features = model.connections.flatMap((connection) =>
			connection.arcs.map((arc, index) => ({
				type: 'Feature' as const,
				id: `${connection.airport.iataCode}-${index}`,
				properties: { code: connection.airport.iataCode, state: connection.state },
				geometry: {
					type: 'LineString' as const,
					coordinates: arc.map((point) => [point.longitude, point.latitude])
				}
			}))
		);
		return { type: 'FeatureCollection' as const, features };
	}

	function baselineData() {
		return {
			type: 'FeatureCollection' as const,
			features: [
				{
					type: 'Feature' as const,
					properties: {},
					geometry: {
						type: 'LineString' as const,
						coordinates: model.directLine.map((point) => [point.longitude, point.latitude])
					}
				}
			]
		};
	}

	function addLayers(instance: MapLibreMap): void {
		const colors = LINE_COLOR[currentColorScheme()];

		instance.addSource('connection-baseline', { type: 'geojson', data: baselineData() });
		instance.addSource('connection-arcs', { type: 'geojson', data: lineFeatures() });

		// Under everything else, thinner than any route and with a longer dash, so it never
		// reads as one of the lines drawn over it. Quieter than a refused route too: a
		// refusal is a fact about a real pair of airports, and this is a line nobody flies,
		// so it has no business being the darkest thing on a light map. The first pass had
		// these the other way round and a light-mode screenshot is what showed it.
		instance.addLayer({
			id: 'connection-baseline',
			type: 'line',
			source: 'connection-baseline',
			layout: { 'line-cap': 'round' },
			paint: { 'line-color': colors.baseline, 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [4, 4] }
		});

		// One layer per state rather than one data-driven expression: `maplibre-gl` does not
		// export the style-spec expression types publicly, so a colour expression needs an
		// unsound cast to type at all, and a plain hex string is exactly what
		// `setPaintProperty` wants. `itinerary-map/style.ts` made the same trade.
		for (const state of ['pending', 'blocked', 'part-priced', 'bookable'] as const) {
			instance.addLayer({
				id: `connection-arcs-${state}`,
				type: 'line',
				source: 'connection-arcs',
				filter: ['==', ['get', 'state'], state],
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					'line-color': colors[state],
					'line-width': ['case', ['boolean', ['feature-state', 'shown'], false], 4, 2],
					'line-opacity': [
						'case',
						['boolean', ['feature-state', 'shown'], false],
						1,
						state === 'bookable' ? 0.8 : 0.55
					],
					// Shape as well as colour, so the four states survive the greyscale test
					// WCAG 1.4.1 asks for. A refused route is a broken line, which is what it
					// is.
					...(state === 'blocked' || state === 'pending' ? { 'line-dasharray': [1.5, 2] } : {})
				}
			});
		}
	}

	function endMarkerElement(iataCode: string, name: string): HTMLElement {
		const element = document.createElement('div');
		element.className = 'connection-end';
		element.setAttribute('role', 'img');
		element.setAttribute('aria-label', name);
		element.textContent = iataCode;
		return element;
	}

	async function renderMarkers(instance: MapLibreMap): Promise<void> {
		const { Marker } = await import('maplibre-gl');
		for (const entry of markers) entry.marker.remove();
		for (const marker of endMarkers) marker.remove();
		markers = [];
		endMarkers = [];

		for (const connection of model.connections) {
			const code = connection.airport.iataCode;
			const element = document.createElement('button');
			element.type = 'button';
			element.className = `connection-point is-${connection.state}`;
			const name = pointLabel(connection, priceLabels[code]);
			// The browser's own tooltip, which SC 1.4.13 exempts because its presentation is
			// the user agent's. The rich version of this lives in the panel, which is the
			// whole design: nothing that appears on hover ever sits under the pointer here.
			element.title = name;
			element.setAttribute('aria-label', name);
			const core = document.createElement('span');
			core.className = 'connection-point-core';
			core.setAttribute('aria-hidden', 'true');
			element.appendChild(core);
			element.addEventListener('pointerenter', () => onpreview(code));
			element.addEventListener('pointerleave', () => onpreview(null));
			element.addEventListener('focus', () => onpreview(code));
			element.addEventListener('blur', () => onpreview(null));
			element.addEventListener('click', () => onpin(code));
			markers.push({
				code,
				element,
				marker: new Marker({ element })
					.setLngLat(pointOf(connection))
					.addTo(instance)
			});
		}

		for (const end of [model.originAirport, model.destinationAirport]) {
			endMarkers.push(
				new Marker({ element: endMarkerElement(end.iataCode, `${end.name} (${end.iataCode})`) })
					.setLngLat([end.coordinates.longitude, end.coordinates.latitude])
					.addTo(instance)
			);
		}

		paintSelection();
	}

	/** The connection's own end of its first arc, so a marker sits exactly where its lines
	 * meet even on a route drawn past the antimeridian, where the airport's raw longitude
	 * and the arc's are a whole turn apart. */
	function pointOf(connection: ConnectionOnMap): [number, number] {
		const join = connection.arcs[0].at(-1) ?? connection.airport.coordinates;
		return [join.longitude, join.latitude];
	}

	function paintSelection(): void {
		for (const entry of markers) {
			entry.element.classList.toggle('is-shown', entry.code === shownCode);
			entry.element.classList.toggle('is-pinned', entry.code === pinnedCode);
			entry.element.setAttribute('aria-pressed', String(entry.code === pinnedCode));
			// A shown point paints over its neighbours rather than under them, so its ring is
			// never clipped by a city three hundred kilometres away.
			entry.element.style.zIndex = entry.code === shownCode ? '2' : entry.code === pinnedCode ? '1' : '';
		}
		if (!map) return;
		for (const connection of model.connections) {
			const shown = connection.airport.iataCode === shownCode;
			for (let index = 0; index < connection.arcs.length; index += 1) {
				map.setFeatureState(
					{ source: 'connection-arcs', id: `${connection.airport.iataCode}-${index}` },
					{ shown }
				);
			}
		}
	}

	/** Every airport on the picture. The view the dialog opens on, and the view the panel's
	 * "show all" returns to. */
	function fitEverything(animate: boolean): void {
		if (!map) return;
		const points: Coordinates[] = [
			model.originAirport.coordinates,
			...model.directLine,
			...model.connections.map((connection) => {
				const [longitude, latitude] = pointOf(connection);
				return { longitude, latitude };
			})
		];
		const [west, south, east, north] = boundsOfCoordinates(points);
		map.fitBounds(
			[
				[west, south],
				[east, north]
			],
			{ padding: 56, maxZoom: 9, duration: animate && !prefersReducedMotion() ? 500 : 0 }
		);
	}

	/** The key the camera was last sent to. A plain variable rather than `$state`, so the
	 * effect below writing it is not the effect reading its own dependency, which is the
	 * shape AGENTS.md records as having frozen every search in production (#87). */
	let framedCode: IataAirportCode | null | undefined;

	// Repainting is cheap and idempotent, so it runs on every pass. Moving the camera is
	// not, and it deliberately only follows a PIN. A sweep across a dozen points would
	// otherwise fly the camera a dozen times and leave the traveller somewhere they never
	// asked to be, which is the opposite of being able to compare them.
	$effect(() => {
		const pinned = pinnedCode;
		if (!mapReady) return;
		// Not untracked, deliberately: reading `shownCode`, `pinnedCode` and `model` is what
		// makes this effect repaint. It writes no `$state` of its own, so it cannot become
		// its own dependency.
		paintSelection();
		if (pinned === framedCode) return;
		framedCode = pinned;
		untrack(() => {
			if (pinned === null) {
				fitEverything(true);
				return;
			}
			const connection = model.connections.find((entry) => entry.airport.iataCode === pinned);
			if (!connection || !map) return;
			// The whole route through this stopover, not the point: a traveller pinning
			// Vienna wants to see the shape of the detour, and a city-level zoom would show
			// them a street map with no lines on it.
			const [west, south, east, north] = boundsOfCoordinates([
				model.originAirport.coordinates,
				...connection.arcs.flat()
			]);
			map.fitBounds(
				[
					[west, south],
					[east, north]
				],
				{ padding: 64, maxZoom: 9, duration: prefersReducedMotion() ? 0 : 500 }
			);
		});
	});

	/** Everything a redraw would change: which connections exist, what state each is in, and
	 * what its point says. `model` itself is rebuilt on every search snapshot, so an effect
	 * keyed on its identity would tear down and recreate twenty DOM markers several times a
	 * second while the results stream in. */
	const drawSignature = $derived(
		model.connections
			.map((connection) => `${connection.airport.iataCode}:${connection.state}:${priceLabels[connection.airport.iataCode] ?? ''}`)
			.join('|')
	);
	let drawnSignature: string | undefined;

	// Redraws when the search streams in a connection that was pending a moment ago. Guarded
	// on `mapReady` so it cannot race the load, and it never touches the camera: a traveller
	// reading one stopover must not have the view yanked because another one resolved.
	$effect(() => {
		const signature = drawSignature;
		if (!mapReady || !map || !linesAdded || signature === drawnSignature) return;
		drawnSignature = signature;
		untrack(() => {
			const arcs = map?.getSource('connection-arcs') as GeoJSONSource | undefined;
			arcs?.setData(lineFeatures());
			const baseline = map?.getSource('connection-baseline') as GeoJSONSource | undefined;
			baseline?.setData(baselineData());
			if (map) void renderMarkers(map);
		});
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
				center: [model.originAirport.coordinates.longitude, model.originAirport.coordinates.latitude],
				zoom: 3,
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
				addLayers(instance);
				linesAdded = true;
				await renderMarkers(instance);
				fitEverything(false);
				framedCode = pinnedCode;
				drawnSignature = drawSignature;
				mapReady = true;
			});

			// A style swap drops every layer with it, so the lines have to be re-added.
			// Markers are DOM elements and survive untouched.
			schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
			onSchemeChange = () => {
				if (!map) return;
				linesAdded = false;
				map.setStyle(MAP_STYLE_URL[currentColorScheme()]);
				map.once('styledata', () => {
					if (destroyed || !map) return;
					addLayers(map);
					linesAdded = true;
					paintSelection();
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
			for (const marker of endMarkers) marker.remove();
			markers = [];
			endMarkers = [];
			// The whole reason this component may only live in a dialog. Without this every
			// open would leak a WebGL context and the ninth one would blank the map.
			map?.remove();
			map = undefined;
			linesAdded = false;
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

<div class="connections-map">
	<div class="connections-map-canvas" bind:this={mapContainer} role="region" aria-label={label}></div>
	{#if !mapReady}
		<div class="connections-map-loading"><Skeleton height="100%" /></div>
	{/if}
	<p class="connections-map-legend">
		<span class="connections-map-key" aria-hidden="true"></span>
		The dashed line is the shortest route between {model.originAirport.iataCode} and
		{model.destinationAirport.iataCode}. Nobody flies it.
	</p>
</div>

<style>
	.connections-map {
		position: relative;
		height: 100%;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
	}

	.connections-map-canvas {
		height: 100%;
	}

	.connections-map-loading {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	/* Sits on the map rather than under it, because the sentence is about the picture and a
	   caption below would be off screen on a phone, where the map is the top half of a
	   stacked dialog. Above the attribution control, which MapLibre pins bottom-right. */
	.connections-map-legend {
		position: absolute;
		/* Top left is the one corner MapLibre leaves alone: the zoom control is top right and
		   the attribution is bottom right. Bottom left put the sentence over the origin
		   airport's own marker, which a screenshot caught. */
		top: var(--space-2);
		left: var(--space-2);
		max-width: min(24rem, calc(100% - 6rem));
		margin: 0;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		line-height: 1.35;
		pointer-events: none;
	}

	/* The same dash the picture draws, so the sentence names which line it is about without
	   a legend block of its own. `FlightDetour`'s caption does this too. */
	.connections-map-key {
		display: inline-block;
		width: 1.25rem;
		height: 0;
		margin-right: var(--space-1);
		border-top: 1px dashed var(--color-text-faint);
		vertical-align: middle;
	}

	/* Markers are created imperatively and appended by MapLibre outside this component's
	   subtree, so their rules are global on purpose, the same arrangement `ItineraryMap`
	   uses for its own. */
	:global(.connection-point) {
		display: grid;
		place-items: center;
		/* 24px, the WCAG 2.5.8 minimum, mostly transparent. Painting a target that size
		   would turn twenty stopovers into twenty overlapping discs. */
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}

	:global(.connection-point-core) {
		width: 12px;
		height: 12px;
		border-radius: var(--radius-full);
		/* The map's own ground colour, so a point over a dark basemap reads as a point
		   rather than as a smudge. */
		box-shadow: 0 0 0 2px var(--color-bg-elevated);
		transition:
			width var(--transition-fast),
			height var(--transition-fast);
	}

	:global(.connection-point.is-bookable .connection-point-core) {
		background: var(--color-stopover);
	}

	:global(.connection-point.is-part-priced .connection-point-core) {
		background: var(--color-accent);
	}

	/* Hollow, not merely dim. A refused stopover has to be told apart from a priced one on a
	   greyscale screen and by anyone who cannot separate teal from amber, so the difference
	   is a hole in the middle rather than a hue. */
	:global(.connection-point.is-blocked .connection-point-core),
	:global(.connection-point.is-pending .connection-point-core) {
		background: var(--color-bg-elevated);
		box-shadow:
			0 0 0 2px var(--color-bg-elevated),
			inset 0 0 0 2px var(--color-text-faint);
	}

	:global(.connection-point:hover .connection-point-core),
	:global(.connection-point.is-shown .connection-point-core) {
		width: 18px;
		height: 18px;
	}

	/* The pin the traveller left. Kept visible while a sweep previews other points, which is
	   the whole reason a pin exists beside a hover. */
	:global(.connection-point.is-pinned .connection-point-core) {
		box-shadow:
			0 0 0 2px var(--color-bg-elevated),
			0 0 0 4px var(--color-text);
	}

	:global(.connection-point:focus-visible) {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-full);
	}

	:global(.connection-end) {
		padding: 2px 6px;
		border-radius: var(--radius-full);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border-strong);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.connection-point-core) {
			transition: none;
		}
	}
</style>
