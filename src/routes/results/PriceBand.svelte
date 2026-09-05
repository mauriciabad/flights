<script lang="ts">
	/**
	 * Issue #232: a fare with no context is a number. This says where this trip's flights sit
	 * among the fares this browser has already seen for the same two airports.
	 *
	 * ## Why it is not Google's traffic light
	 *
	 * The owner saw green/amber/red segments on Google Flights and asked for the same
	 * information. He gets the information; the colours are the app's own, and the reasons
	 * are three.
	 *
	 * A red/amber/green scale is a STATUS palette, and a dear fare is not an error. On a
	 * route with one carrier and no alternative, red would be telling the traveller off for
	 * the only flight there is. Second, `/results/when/`'s year grid already bands price by
	 * quantile, in one brass ramp, for exactly this reason, and two colour languages for one
	 * fact read as two different facts. Third, red-against-green is the classic pair a
	 * red-green colour blind reader cannot separate, and a one-hue ramp separated by
	 * lightness is safe by construction rather than by measurement.
	 *
	 * So the track is three steps of that same ramp and it is deliberately quiet. Colour
	 * carries nothing here: the track is `aria-hidden` and the sentence under it states the
	 * rank in words, which is also what makes this legible with no colour at all.
	 *
	 * ## Why the marker is ink rather than the accent
	 *
	 * The one thing on the track that must be found instantly is where this trip is. Ink on
	 * brass, with a ring in the card's own surface colour, is the highest contrast available
	 * in both themes and cannot collide with a zone's hue. It is the `marks-and-anatomy`
	 * surface-ring rule: the ring is what keeps an overlapping mark readable.
	 *
	 * At either end of the track the dot sits half outside it, because it is centred on its
	 * own position and the position is clamped. That reads as "off the end", which is
	 * exactly what a fare cheaper than the tenth percentile is, and the sentence says so too.
	 */
	import { formatMoney } from '$lib/format';
	import { bandEvidenceSentence, bandRankSentence } from '$lib/results/price-band';
	import type { BandPosition, PriceHistory } from '$lib/results/price-band';
	import type { IataAirportCode, Money } from '$lib/domain';

	interface Props {
		band: PriceHistory;
		position: BandPosition;
		/** The figure the marker is on: this trip's two fares for one adult. Printed rather
		 * than implied, because the headline directly above is a different, larger number
		 * (the whole party's door-to-door cost) and a range beside it would otherwise read
		 * as banding that. */
		comparable: Money;
		route: { origin: IataAirportCode; destination: IataAirportCode };
		/** Matches the rest of the card's greyed-out treatment for a deprioritised airline,
		 * so a quiet card does not carry one loud element. */
		deprioritized?: boolean;
	}

	let { band, position, comparable, route, deprioritized = false }: Props = $props();

	const low = $derived(formatMoney({ minorUnits: band.lowMinorUnits, currency: band.currency }));
	const high = $derived(formatMoney({ minorUnits: band.highMinorUnits, currency: band.currency }));
	const zones = [0, 1, 2];
</script>

<div class={['price-band', { 'is-quiet': deprioritized }]}>
	<p class="band-head">
		<span class="band-label">Seen for this route</span>
		<span class="band-figure font-mono tabular-nums">1 adult, flights {formatMoney(comparable)}</span>
	</p>

	<!-- The graphic is `aria-hidden` because it encodes only what the marker's position says,
	     and the sentence below says that in words. The two prices are NOT hidden with it: they
	     are the extent of the band and a reader who cannot see the track still needs them, so
	     the words that turn two bare figures into a range are carried by `.visually-hidden`
	     rather than by the picture. -->
	<p class="band-scale">
		<span class="visually-hidden">Ranged from </span>
		<span class="band-end font-mono tabular-nums">{low}</span>
		<span class="visually-hidden"> to </span>
		<span class="band-track" aria-hidden="true">
			{#each zones as zone (zone)}
				<span class="band-zone" data-zone={zone}></span>
			{/each}
			<span class="band-marker" style:left="{position.fraction * 100}%"></span>
		</span>
		<span class="band-end font-mono tabular-nums">{high}</span>
	</p>

	<p class="band-note">
		{bandRankSentence(position, route)}
		<span class="band-evidence">{bandEvidenceSentence(band)}</span>
	</p>
</div>

<style>
	.price-band {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* The same shape `PriceLine`'s own headline uses: name on the left, figure hard right,
	   so a card reads down one right edge whichever block you are looking at. */
	.band-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-1) var(--space-3);
		margin: 0;
	}

	.band-label {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.band-figure {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	/* Axis ends beside the track rather than under it: one row instead of two, and the two
	   prices then read as the ends of the scale rather than as a second pair of figures. */
	.band-scale {
		display: grid;
		/* The two `.visually-hidden` spans are out of flow, so the three visible children land
		   in these three columns. */
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
	}

	/* Muted, not faint. `--color-text-faint` measures 4.18:1 against the ticket surface in
	   dark mode, which is under WCAG AA for text this size, and these two figures are the
	   only place the band's extent is written down. */
	.band-end {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
	}

	.band-track {
		position: relative;
		display: flex;
		/* Thin: this is an axis, not the data. `marks-and-anatomy`'s recessive-grid rule. */
		height: 0.375rem;
		/* The 2px surface gap that separates touching marks. A stroke around each zone would
		   add ink that is not data. */
		gap: 2px;
	}

	.band-zone {
		flex: 1;
		border-radius: 1px;
		/* Quiet on purpose. The ramp says which way is cheap; it is not competing with the
		   marker, and it is not making a claim of its own. */
		opacity: 0.7;
	}

	/* Three steps of the brass ramp `/results/when/`'s YearGrid already bands with, cheapest
	   first. In dark mode cheapest is the brightest step and in light mode the darkest, which
	   in both cases is "cheapest has the most contrast against the card". */
	.band-zone[data-zone='0'] {
		background: var(--color-accent-hover);
	}

	.band-zone[data-zone='1'] {
		background: var(--color-accent);
	}

	.band-zone[data-zone='2'] {
		background: #8a6224;
	}

	.band-marker {
		position: absolute;
		top: 50%;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
		background: var(--color-text);
		/* The surface ring, so the dot stays readable wherever it lands on the track. */
		box-shadow: 0 0 0 2px var(--color-surface);
		transform: translate(-50%, -50%);
	}

	.band-note {
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text);
	}

	/* The caveat, quieter than the claim but on the same line of text, because a reader who
	   takes the number must take the qualification with it. Never a tooltip: the issue is
	   explicit that the sample and the source belong on screen. */
	.band-evidence {
		color: var(--color-text-muted);
	}

	.price-band.is-quiet .band-note {
		color: var(--color-text-deprioritized);
	}

	.price-band.is-quiet .band-zone {
		opacity: 0.3;
	}

	.price-band.is-quiet .band-marker {
		background: var(--color-text-deprioritized);
	}

	@media (prefers-color-scheme: light) {
		.band-zone[data-zone='2'] {
			background: #c08a3a;
		}
	}
</style>
