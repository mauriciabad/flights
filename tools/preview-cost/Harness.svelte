<script lang="ts">
	/**
	 * `RoutePreview` mounted the way a results page mounts it, and nothing else on the page.
	 *
	 * Driven by `tools/probe-preview-cost.mjs`. The point of it is that the component is the
	 * real one, imported from `src/`, so the number this produces moves when `land.ts`,
	 * `land-tiles.svelte.ts` or the generated data move. `tools/probe-map-cost.mjs` writes
	 * its own SVG by hand — that was the right instrument for "SVG or MapLibre" and it is
	 * the wrong one for "did this change make the SVG slower", because it never runs any of
	 * this app's code.
	 *
	 * Four previews per card, which is the layout the owner asked for in #280: one flight
	 * ornament and three ground legs.
	 */
	import RoutePreview from '$lib/components/RoutePreview.svelte';
	import { greatCircleArc } from '$lib/itinerary-map/geo';
	import type { Coordinates } from '$lib/domain';
	import type { PreviewLine, PreviewPoint } from '$lib/itinerary-map/previews';

	interface Props {
		cards: number;
	}
	let { cards }: Props = $props();

	const at = (latitude: number, longitude: number): Coordinates => ({ latitude, longitude });

	/**
	 * Geneva to Vienna to Copenhagen, and the three ground legs are chosen rather than
	 * arbitrary: each one is a case `land.ts` decides differently.
	 *
	 *   Basel       EuroAirport is in France and the city is in Switzerland, so the ride
	 *               between them crosses a national border. This is the leg that draws one
	 *               at ground-leg zoom.
	 *   Vienna      inland, no coast and no border in the window. Fills solid, and that is
	 *               the true answer rather than a missing one.
	 *   Copenhagen  the airport is on Amager with the Øresund beside it, which is the case
	 *               #408 was actually filed about.
	 *
	 * A run where the Copenhagen leg has no water in it is a broken tile fetch, not a fast
	 * render, and the probe's `solid` column is there to say which.
	 */
	const TRIP = {
		originLocation: at(47.5596, 7.5886),
		originAirport: at(47.5896, 7.5299),
		connectionAirport: at(48.1103, 16.5697),
		stay: at(48.2082, 16.3738),
		destinationAirport: at(55.618, 12.6508),
		destinationLocation: at(55.6797, 12.5913)
	};

	/** A road, roughly: a straight run with a dogleg in it, at the point count OSRM's
	 *  thinned `full` geometry actually returns for a leg this length. */
	function road(from: Coordinates, to: Coordinates, points = 40): Coordinates[] {
		return Array.from({ length: points }, (_, i) => {
			const t = i / (points - 1);
			const wobble = Math.sin(t * Math.PI * 3) * 0.004;
			return at(
				from.latitude + (to.latitude - from.latitude) * t + wobble,
				from.longitude + (to.longitude - from.longitude) * t + wobble
			);
		});
	}

	const line = (coordinates: Coordinates[], tone: PreviewLine['tone'] = 'neutral'): PreviewLine => ({
		coordinates,
		geometryKind: 'real',
		tone
	});
	const dot = (coordinates: Coordinates, tone: PreviewPoint['tone'] = 'neutral'): PreviewPoint => ({
		coordinates,
		tone
	});

	const flight = {
		lines: [
			line(greatCircleArc(TRIP.originAirport, TRIP.connectionAirport)),
			line(greatCircleArc(TRIP.connectionAirport, TRIP.destinationAirport), 'stopover')
		],
		points: [dot(TRIP.originAirport), dot(TRIP.connectionAirport, 'stopover'), dot(TRIP.destinationAirport)],
		baseline: greatCircleArc(TRIP.originAirport, TRIP.destinationAirport)
	};

	const ground = [
		{
			lines: [line(road(TRIP.originLocation, TRIP.originAirport))],
			points: [dot(TRIP.originLocation), dot(TRIP.originAirport)]
		},
		{
			lines: [line(road(TRIP.connectionAirport, TRIP.stay), 'stopover')],
			points: [dot(TRIP.connectionAirport, 'stopover'), dot(TRIP.stay, 'stopover')]
		},
		{
			lines: [line(road(TRIP.destinationAirport, TRIP.destinationLocation))],
			points: [dot(TRIP.destinationAirport), dot(TRIP.destinationLocation)]
		}
	];

	const rows = $derived(Array.from({ length: cards }, (_, index) => index));
</script>

{#each rows as card (card)}
	<div class="card">
		<RoutePreview lines={flight.lines} points={flight.points} baseline={flight.baseline} width={320} height={96} />
		<div class="legs">
			{#each ground as leg, index (index)}
				<RoutePreview lines={leg.lines} points={leg.points} width={120} height={88} />
			{/each}
		</div>
	</div>
{/each}

<style>
	.card {
		max-width: 40rem;
		margin: 0 auto 1rem;
		padding: 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 0.75rem;
		background: var(--color-bg);
	}

	.legs {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.legs > :global(*) {
		flex: 1 1 0;
		min-width: 0;
	}
</style>
