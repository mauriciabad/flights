<script lang="ts">
	/**
	 * The whole trip as one horizontal band: fly, stay, fly. Roughly proportional to real
	 * time (`trip-strip.ts` owns that arithmetic and explains the floor on each span), so
	 * a three-night stopover reads as a wide teal stretch and a two-hour one reads as a
	 * seam between two flights, before anybody reads a number.
	 *
	 * It is a picture, not a control. The rows above and below it carry the codes, the
	 * carriers and the durations as real text, and the whole thing is announced to a
	 * screen reader as one sentence through `aria-label` on a `role="img"` wrapper, since
	 * a bar chart read cell by cell is worse than useless.
	 *
	 * The codes and the bars share a three-column grid whose tracks are the spans' own
	 * shares, so a code lands exactly on the boundary it names. The tracks are
	 * `minmax(0, Nfr)` rather than plain `Nfr`, which matters: a plain `fr` track floors at
	 * its content's min-content width, so a caption wider than its own bar would quietly
	 * widen that bar and the picture would stop being proportional. The captions therefore
	 * live in their own flex row underneath, where their width cannot distort anything.
	 */
	import type { Itinerary } from '$lib/domain';
	import { formatDuration, formatLongDuration } from '$lib/format';
	import { tripStrip } from './trip-strip';
	import AirlineLogo from './AirlineLogo.svelte';

	interface Props {
		itinerary: Itinerary;
		/** The stopover city's name once the caller has resolved the airport record
		 * (`getAirport` is async). Falls back to the IATA code, never to a guess. */
		connectionLabel?: string;
		/** The stopover's IATA code, when the caller already has it. Defaults to the one
		 * fact the itinerary always carries: where the outbound flight lands. */
		connectionCode?: string;
		/** Colour-only quieting for an itinerary on an avoided airline. */
		deprioritized?: boolean;
	}

	let { itinerary, connectionLabel, connectionCode, deprioritized = false }: Props = $props();

	const strip = $derived(tripStrip(itinerary));
	const stopoverCode = $derived(connectionCode ?? itinerary.outboundFlight.arrivalAirport);
	const stopoverName = $derived(connectionLabel ?? stopoverCode);
	const nights = $derived(itinerary.nightsInConnection);
	const template = $derived(strip.spans.map((span) => `minmax(0, ${span.share.toFixed(4)}fr)`).join(' '));

	const summary = $derived(
		[
			`${itinerary.originAirport.iataCode} to ${stopoverCode}, ${formatDuration(strip.spans[0].minutes)} in the air`,
			nights > 0
				? `${nights} ${nights === 1 ? 'night' : 'nights'} in ${stopoverName}`
				: `${formatDuration(strip.spans[1].minutes)} in ${stopoverName}`,
			`${stopoverCode} to ${itinerary.destinationAirport.iataCode}, ${formatDuration(strip.spans[2].minutes)} in the air`
		].join(', then ')
	);
</script>

<div class={['trip-strip', { 'is-quiet': deprioritized }]} role="img" aria-label={summary}>
	<div class="trip-strip-track" style:grid-template-columns={template}>
		<span class="trip-strip-code trip-strip-code-start font-mono">{itinerary.originAirport.iataCode}</span>
		<span class="trip-strip-code trip-strip-code-mid font-mono">{stopoverCode}</span>
		<span class="trip-strip-code trip-strip-code-end font-mono">{itinerary.destinationAirport.iataCode}</span>

		<div class="trip-strip-bar trip-strip-bar-flight">
			<AirlineLogo
				iataCode={itinerary.outboundFlight.carrier.iataCode}
				name={itinerary.outboundFlight.carrier.name}
				{deprioritized}
			/>
		</div>
		<div class="trip-strip-bar trip-strip-bar-stopover"></div>
		<div class="trip-strip-bar trip-strip-bar-flight">
			<AirlineLogo
				iataCode={itinerary.onwardFlight.carrier.iataCode}
				name={itinerary.onwardFlight.carrier.name}
				{deprioritized}
			/>
		</div>
	</div>

	<p class="trip-strip-captions">
		<span class="trip-strip-caption font-mono tabular-nums">{formatDuration(strip.spans[0].minutes)}</span>
		<span class="trip-strip-caption trip-strip-caption-mid">
			{#if nights > 0}
				<strong class="trip-strip-nights font-mono tabular-nums">{nights}</strong>
				{nights === 1 ? 'night' : 'nights'} in {stopoverName}
			{:else}
				<strong class="trip-strip-nights font-mono tabular-nums"
					>{formatLongDuration(strip.spans[1].minutes)}</strong
				>
				in {stopoverName}
			{/if}
		</span>
		<span class="trip-strip-caption font-mono tabular-nums">{formatDuration(strip.spans[2].minutes)}</span>
	</p>
</div>

<style>
	.trip-strip {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	/* Codes on row 1, bars on row 2, both on the proportional tracks. */
	.trip-strip-track {
		display: grid;
		grid-template-rows: auto auto;
		align-items: center;
		row-gap: var(--space-1);
		column-gap: 2px;
	}

	/* A code marks a place on the line, so it sits at the boundary it belongs to: the
	   origin at the left edge, the stopover exactly where the first flight ends, the
	   destination at the right edge. Overflow stays visible, since the row above the bars
	   is otherwise empty and a clipped airport code is worse than a slightly wide one. */
	.trip-strip-code {
		grid-row: 1;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.trip-strip-code-start {
		grid-column: 1;
		justify-self: start;
	}

	.trip-strip-code-mid {
		grid-column: 2;
		justify-self: start;
		color: var(--color-stopover);
	}

	.trip-strip-code-end {
		grid-column: 3;
		justify-self: end;
	}

	.trip-strip-bar {
		grid-row: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		height: 1.75rem;
		border-radius: var(--radius-sm);
	}

	.trip-strip-bar-flight {
		background: var(--color-accent-muted);
		/* A hairline in the accent itself, so the band still reads as a band in the light
		   palette where `--color-accent-muted` is a very pale cream. */
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	/* The stopover is the thing this app is selling, so it gets the reserved teal and the
	   torn-ticket dashes the timeline's own stopover row already uses. */
	.trip-strip-bar-stopover {
		background: var(--color-stopover-bg);
		border: 1px dashed var(--color-stopover);
	}

	/* Outside the proportional grid on purpose: see the header comment. */
	.trip-strip-captions {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.trip-strip-caption {
		font-size: var(--font-size-xs);
		line-height: 1.3;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.trip-strip-caption-mid {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
		color: var(--color-stopover);
	}

	.trip-strip-nights {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-bold);
	}

	/* Avoided airlines: quiet, never hidden, and colour only. The teal is what carries the
	   "this is the good part" meaning, so it is the thing that steps back. */
	.is-quiet .trip-strip-code-mid,
	.is-quiet .trip-strip-caption-mid {
		color: var(--color-text-deprioritized);
	}

	.is-quiet .trip-strip-bar-flight {
		background: var(--color-bg-inset);
		box-shadow: inset 0 0 0 1px var(--color-border-strong);
	}

	.is-quiet .trip-strip-bar-stopover {
		background: var(--color-bg-inset);
		border-color: var(--color-border-strong);
	}
</style>
