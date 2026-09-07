<script lang="ts">
	/**
	 * One saved trip, whole: the journey as it was when it was kept, and every price this
	 * browser has seen it at since.
	 *
	 * Shaped like a ticket, because that is what it is. The upper half is the trip and the
	 * lower half is the receipt, and a dashed rule runs between them where a ticket tears.
	 * Everything on the upper half is drawn from the stored snapshot alone, so this card
	 * renders identically with every provider key removed and the aeroplane on.
	 *
	 * The receipt is opened out rather than folded behind a disclosure. The owner asked for
	 * the breakdown and not only the total ("save the breakdown not just the final number"),
	 * and a breakdown nobody opens is the same as no breakdown.
	 */
	import { base } from '$app/paths';
	import { Icon, ModeIcon } from '$lib/components';
	import { formatCalendarDate, formatClockTime, formatMoney, formatPropertyRating } from '$lib/format';
	import { transferModeLabel } from '$lib/components/itinerary-timeline-format';
	import { ROOM_KIND_LABELS } from '$lib/stays/room-kind';
	import {
		formatObservedDate,
		GROUND_LEG_LABELS,
		observationParts,
		priceTrend,
		sparkline,
		summarizeSavedItinerary,
		trendNote
	} from '$lib/saved';
	import type { SavedFlight, SavedItinerary } from '$lib/saved';

	interface Props {
		entry: SavedItinerary;
		onremove: () => void;
	}

	let { entry, onremove }: Props = $props();

	const summary = $derived(summarizeSavedItinerary(entry));
	const latest = $derived(entry.prices.at(-1));
	const trend = $derived(priceTrend(entry.prices));
	const note = $derived(trendNote(trend));
	/** Newest first in the table, because the price a traveller came to check is this one. The
	 * stored log runs the other way, which is what a chart reads. */
	const log = $derived([...entry.prices].reverse());

	/** Sized in user units and drawn into a box the CSS stretches, so the line keeps its
	 * shape at every width without this component measuring anything. */
	const CHART = { width: 320, height: 48 };
	const line = $derived(sparkline(entry.prices, CHART));

	function flightDate(flight: SavedFlight): string {
		return formatCalendarDate(flight.departure);
	}
</script>

<article class="trip" aria-label={summary.label}>
	<header class="trip-head">
		<p class="trip-route font-mono">
			{summary.originAirport}<span class="arrow" aria-hidden="true">&rarr;</span><span
				class="via">{summary.connectionAirport}</span
			><span class="arrow" aria-hidden="true">&rarr;</span>{summary.destinationAirport}
		</p>
		<p class="trip-when">{summary.dates}</p>
		<p class="trip-stay text-stopover">{summary.stopover}</p>
		<p class="trip-party">{summary.travellers}</p>
	</header>

	<ol class="legs">
		{#each [entry.trip.outboundFlight, entry.trip.onwardFlight] as flight (flight.flightNumber + flight.departure.local)}
			<li class="leg">
				<span class="leg-icon"><ModeIcon kind="flight" size="md" /></span>
				<span class="leg-name">
					<span class="font-mono">{flight.flightNumber}</span>
					<span class="leg-carrier">{flight.carrier.name}</span>
				</span>
				<span class="leg-clock font-mono tabular-nums">
					<span title={flight.departure.timeZone}>{formatClockTime(flight.departure)}</span>
					<span class="arrow" aria-hidden="true">&rarr;</span>
					<span title={flight.arrival.timeZone}>{formatClockTime(flight.arrival)}</span>
				</span>
				<span class="leg-date">{flightDate(flight)}</span>
			</li>
		{/each}

		{#if entry.trip.bed}
			<li class="leg">
				<span class="leg-icon"><ModeIcon kind="stopover" size="md" /></span>
				<span class="leg-name">
					{entry.trip.bed.propertyName}
					<span class="leg-carrier">{ROOM_KIND_LABELS[entry.trip.bed.roomKind]}</span>
				</span>
				{#if entry.trip.bed.rating}
					<span class="leg-rating font-mono tabular-nums">
						{formatPropertyRating(entry.trip.bed.rating)}
					</span>
				{/if}
			</li>
		{/if}

		{#each entry.trip.groundLegs as leg (leg.leg)}
			<li class="leg">
				<span class="leg-icon"><ModeIcon kind={leg.mode} size="md" /></span>
				<span class="leg-name">
					{GROUND_LEG_LABELS[leg.leg]}
					<span class="leg-carrier">{transferModeLabel(leg.mode)}</span>
				</span>
			</li>
		{/each}
	</ol>

	<div class="receipt">
		<div class="receipt-head">
			<p class="receipt-now">
				<span class="receipt-label">Now</span>
				<span class="font-mono tabular-nums">
					{latest ? formatMoney(latest.total) : 'Not priced yet'}
				</span>
			</p>
			{#if note}
				<p class={['receipt-note', `is-${note.direction}`]}>{note.long}</p>
			{/if}
		</div>

		{#if line}
			<figure class="chart">
				<!-- aria-hidden, because the table below is the same numbers in a form a screen
				     reader can actually read. A chart that is also announced is the same data twice
				     and neither reading is the good one. -->
				<svg
					class="chart-line"
					viewBox={`-2 -2 ${CHART.width + 4} ${CHART.height + 4}`}
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<polyline points={line.points} />
					{#each line.plotted as point (point.observation.visit)}
						<circle cx={point.x} cy={point.y} r="2.5" />
					{/each}
				</svg>
				<figcaption class="chart-scale font-mono tabular-nums">
					<!-- The line itself is hidden from a screen reader, so the caption has to say
					     what it was a picture of before it reads out two amounts. -->
					<span class="visually-hidden">Total price over time.</span>
					<span>Low {formatMoney(line.low)}</span>
					<span>High {formatMoney(line.high)}</span>
				</figcaption>
			</figure>
		{/if}

		<!-- These roles are redundant at desktop width and load-bearing below 34rem, where the
		     stylesheet turns every one of these elements into a block so five money columns can
		     stack on a phone. A browser drops a table's own roles the moment its `display`
		     changes, and without them a screen reader at that width hears a run of unlabelled
		     amounts. `svelte-ignore` because the compiler checks the markup and cannot see the
		     media query. -->
		<!-- svelte-ignore a11y_no_redundant_roles -->
		<table class="log" role="table">
			<caption class="visually-hidden">
				Every price seen for this trip, newest first, with what each part cost
			</caption>
			<thead>
				<!-- svelte-ignore a11y_no_redundant_roles -->
				<tr role="row">
					<th scope="col" role="columnheader">Seen</th>
					<th scope="col" role="columnheader" class="amount">Flights</th>
					<th scope="col" role="columnheader" class="amount">Bed</th>
					<th scope="col" role="columnheader" class="amount">Ground</th>
					<th scope="col" role="columnheader" class="amount">Total</th>
				</tr>
			</thead>
			<tbody>
				{#each log as observation (observation.visit)}
					<!-- svelte-ignore a11y_no_redundant_roles -->
					<tr role="row">
						<th scope="row" role="rowheader">
							<span class="log-when">{formatObservedDate(observation.observedAt)}</span>
							<span class="log-nights">
								{observation.nights === 1 ? '1 night' : `${observation.nights} nights`}
							</span>
						</th>
						{#each observationParts(observation) as part (part.id)}
							<td class="amount font-mono tabular-nums" role="cell">
								<!-- Visible only in the narrow layout, where the column headings are off
								     screen. Hidden from a screen reader either way, since the `<th>` above
								     already names the column. -->
								<span class="cell-label" aria-hidden="true">{part.label}</span>
								{#if part.money}
									<span>{formatMoney(part.money)}</span>
								{:else}
									<!-- Not a zero. "Nobody priced this" and "this costs nothing" are
									     different facts, and the stored row keeps them apart. -->
									<span class="log-unpriced" title={`No ${part.label.toLowerCase()} price was quoted`}>
										not priced
									</span>
								{/if}
							</td>
						{/each}
						<td class="amount font-mono tabular-nums log-total" role="cell">
							<span class="cell-label" aria-hidden="true">Total</span>
							<span>{formatMoney(observation.total)}</span>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<footer class="trip-actions">
		<a class="action action-open" href={`${base}/results/?${entry.query}`}>
			Open this search
			<Icon name="arrow-right" />
		</a>
		<button type="button" class="action action-remove" onclick={onremove}>
			<Icon name="heart-minus" />
			Remove
		</button>
	</footer>
</article>

<style>
	.trip {
		display: flex;
		flex-direction: column;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		/* Kept, rather than merely visited. `RecentSearches` marks a used stub in the stopover
		   teal; this is the ticket still in the pocket. */
		border-left: 3px solid var(--color-accent);
		overflow: hidden;
	}

	.trip-head {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: baseline;
		gap: var(--space-1) var(--space-4);
		padding: var(--space-4);
		background: var(--color-accent-muted);
	}

	.trip-route {
		grid-column: 1;
		font-size: var(--font-size-xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.via {
		color: var(--color-stopover);
	}

	.arrow {
		padding-inline: var(--space-1);
		color: var(--color-accent-muted-text);
	}

	.trip-when {
		grid-column: 2;
		grid-row: 1;
		text-align: end;
		font-size: var(--font-size-sm);
		color: var(--color-accent-muted-text);
	}

	.trip-stay {
		grid-column: 1;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
	}

	.trip-party {
		grid-column: 2;
		text-align: end;
		font-size: var(--font-size-sm);
		color: var(--color-accent-muted-text);
	}

	.legs {
		display: flex;
		flex-direction: column;
		padding: var(--space-2) var(--space-4);
	}

	.leg {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: baseline;
		column-gap: var(--space-3);
		row-gap: var(--space-1);
		padding-block: var(--space-2);
	}

	.leg + .leg {
		border-top: 1px solid var(--color-border);
	}

	.leg-icon {
		grid-row: 1 / span 2;
		align-self: center;
		color: var(--color-text-faint);
	}

	.leg-name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-2);
		font-weight: var(--font-weight-medium);
	}

	.leg-carrier {
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-regular);
		color: var(--color-text-muted);
	}

	.leg-clock {
		font-size: var(--font-size-sm);
		white-space: nowrap;
	}

	.leg-date,
	.leg-rating {
		grid-column: 3;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		white-space: nowrap;
	}

	/* Where the ticket tears. The receipt below is a different claim from the trip above:
	   one is what was booked, the other is what it has cost since. */
	.receipt {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		border-top: 1px dashed var(--color-border-strong);
		background: var(--color-bg-inset);
	}

	.receipt-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
	}

	.receipt-now {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		font-size: var(--font-size-2xl);
		font-weight: var(--font-weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.receipt-label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.receipt-note {
		flex: 1 1 14rem;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.receipt-note.is-cheaper {
		color: var(--color-success);
	}

	.receipt-note.is-dearer {
		color: var(--color-danger);
	}

	.chart {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.chart-line {
		width: 100%;
		height: 3.5rem;
		overflow: visible;
	}

	.chart-line polyline {
		fill: none;
		stroke: var(--color-accent);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		/* The box is stretched, so a plain stroke would be stretched with it and read thicker
		   on a wide screen than on a phone. */
		vector-effect: non-scaling-stroke;
	}

	.chart-line circle {
		fill: var(--color-accent);
	}

	.chart-scale {
		display: flex;
		justify-content: space-between;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.log {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--font-size-sm);
	}

	.log th,
	.log td {
		padding: var(--space-2) var(--space-1);
		text-align: start;
		vertical-align: baseline;
	}

	.log thead th {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
		border-bottom: 1px solid var(--color-border);
	}

	.log tbody th {
		font-weight: var(--font-weight-regular);
		white-space: nowrap;
	}

	.log .amount {
		text-align: end;
	}

	.log-when {
		display: block;
	}

	.log-nights {
		display: block;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.log-unpriced {
		color: var(--color-text-faint);
		font-style: italic;
	}

	.log-total {
		font-weight: var(--font-weight-semibold);
	}

	.cell-label {
		display: none;
	}

	/* Five money columns do not fit a phone, and a receipt that scrolls sideways hides the
	   number somebody came to check. So below this width each visit stops being a row and
	   becomes a small block: when it was seen, then one labelled line per part. The `<th>`
	   headings stay in the accessibility tree, clipped rather than removed, so the columns
	   still name themselves to a screen reader; the visible labels beside each amount are
	   `aria-hidden` so nothing is announced twice. */
	@media (max-width: 34rem) {
		.log thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		.log tbody tr {
			display: block;
			padding-block: var(--space-2);
		}

		.log tbody tr + tr {
			border-top: 1px solid var(--color-border);
		}

		.log tbody th,
		.log tbody td {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: var(--space-4);
			padding-inline: 0;
			padding-block: var(--space-1);
		}

		.log tbody th {
			padding-top: 0;
			font-weight: var(--font-weight-semibold);
		}

		.log-nights {
			display: inline;
			color: var(--color-text-faint);
		}

		.cell-label {
			display: inline;
			font-family: var(--font-sans);
			font-size: var(--font-size-xs);
			text-transform: uppercase;
			letter-spacing: var(--tracking-wide);
			color: var(--color-text-faint);
		}

		.log-total .cell-label {
			color: var(--color-text-muted);
		}
	}

	.trip-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--color-border);
	}

	.action {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		/* 44px, per WCAG 2.5.5. */
		min-height: 2.75rem;
		padding-inline: var(--space-4);
		border-radius: var(--radius-md);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		text-decoration: none;
	}

	.action :global(svg) {
		width: 1rem;
		height: 1rem;
	}

	.action-open {
		flex: 1 1 12rem;
		background: var(--color-accent);
		color: var(--color-accent-text);
	}

	.action-open:hover {
		background: var(--color-accent-hover);
	}

	.action-remove {
		color: var(--color-text-muted);
	}

	.action-remove:hover {
		color: var(--color-danger);
		background: var(--color-danger-bg);
	}

	.action:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	/* The trip and its receipt sit side by side once there is room for both, so a desktop
	   reader compares the journey with what it has cost without scrolling between them. */
	@media (min-width: 60rem) {
		.trip {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
			grid-template-areas:
				'head receipt'
				'legs receipt'
				'actions receipt';
			grid-template-rows: auto 1fr auto;
		}

		.trip-head {
			grid-area: head;
		}

		.legs {
			grid-area: legs;
		}

		.receipt {
			grid-area: receipt;
			border-top: none;
			border-left: 1px dashed var(--color-border-strong);
		}

		.trip-actions {
			grid-area: actions;
		}
	}
</style>
