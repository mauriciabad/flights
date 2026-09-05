<script lang="ts">
	/**
	 * The four date fields as one calendar, issue #277. The owner: "to enter the dates, we
	 * simply have 4 date inoputs, a better experience would be a more advanced calendar
	 * component that i can pick multiple dates and visually displays the intervals".
	 *
	 * Two rails per day, not one selection. The top rail is the departure window and the
	 * bottom rail is the arrival window, and they are the same brass because this app has
	 * exactly one accent colour. What tells them apart is where they sit in the cell, their
	 * end caps, the legend, and each day's own accessible name - never hue, so the control
	 * still reads for anyone who cannot separate two shades of gold. `date-window.ts`
	 * explains why there are two of them and why they overlap by default.
	 *
	 * The four typed inputs are still here, under the calendar and smaller. That is not a
	 * hedge: GOV.UK's own date guidance is "never make a calendar control that depends on
	 * JavaScript as the only input option, allow users to enter the date into a text input
	 * as well as use the control", and the same page is what justifies a calendar here at
	 * all, since it lists "be able to see dates in relation to other dates" as the case a
	 * calendar is for. Two ranges that overlap is exactly that case.
	 * https://design-system.service.gov.uk/patterns/dates/
	 *
	 * Keyboard follows the ARIA grid pattern: one tab stop for the whole calendar, arrows
	 * to move a day, Home and End for the week, Page Up and Page Down for the month. A
	 * calendar you can only use with a mouse is worse than the four boxes it replaced.
	 */
	import { tick, untrack } from 'svelte';
	import { Icon } from '$lib/components';
	import { addDays, datesInMonth, monthLabel, weekdayIndex } from '$lib/flexible-dates';
	import type { IsoCalendarDate } from '$lib/domain';
	import {
		armTarget,
		describeDay,
		INITIAL_PAINT,
		markDay,
		paintDay,
		previewWindows,
		rangeLabel,
		resolveWindows,
		spanLength,
		visibleMonths,
		type DateWindowFields,
		type PaintTarget
	} from './date-window';
	import { FIELD_INPUT_ID, type SearchFieldKey } from './validation';

	interface Props {
		fields: DateWindowFields;
		/** Today's calendar date, `YYYY-MM-DD`. The parent owns the clock. */
		today: string;
		errors: Partial<Record<SearchFieldKey, string>>;
		onchange: (next: DateWindowFields) => void;
		ontouch: (field: SearchFieldKey) => void;
	}

	let { fields, today, errors, onchange, ontouch }: Props = $props();

	let paint = $state(INITIAL_PAINT);
	let hovered = $state<string | undefined>(undefined);
	/** Where the arrow keys start. Seeded once and then owned by the keyboard, so `untrack`
	 * says out loud that it deliberately does not follow the dates afterwards: a tap that
	 * moves the window must not yank the cursor out from under someone mid-arrow. */
	let focusedDate = $state(untrack(() => fields.soonestDeparture.trim() || today));
	let gridEl = $state<HTMLDivElement | undefined>();

	const months = $derived(visibleMonths(today, fields));
	const lastDate = $derived(months.length ? monthEnd(months[months.length - 1]) : today);
	/** What the rails draw: the real windows, or the range the next tap would produce while
	 * a travel window is half drawn. */
	const drawn = $derived(previewWindows(fields, paint, hovered));
	const resolved = $derived(resolveWindows(fields));

	const WEEKDAYS = [
		{ short: 'Mo', long: 'Monday' },
		{ short: 'Tu', long: 'Tuesday' },
		{ short: 'We', long: 'Wednesday' },
		{ short: 'Th', long: 'Thursday' },
		{ short: 'Fr', long: 'Friday' },
		{ short: 'Sa', long: 'Saturday' },
		{ short: 'Su', long: 'Sunday' }
	];

	interface DayCell {
		date: IsoCalendarDate;
		day: number;
		weekend: boolean;
	}

	interface Week {
		key: string;
		/** Seven entries. `undefined` is a leading or trailing pad, so every month's Monday
		 * column is the same column. */
		cells: (DayCell | undefined)[];
	}

	interface Month {
		monthStart: IsoCalendarDate;
		label: string;
		weeks: Week[];
	}

	function monthEnd(monthStart: IsoCalendarDate): IsoCalendarDate {
		const dates = datesInMonth(monthStart);
		return dates[dates.length - 1] ?? monthStart;
	}

	function buildMonth(monthStart: IsoCalendarDate): Month {
		const dates = datesInMonth(monthStart);
		const weeks: Week[] = [];
		let cells: (DayCell | undefined)[] = Array(weekdayIndex(dates[0])).fill(undefined);
		for (const date of dates) {
			cells.push({ date, day: Number(date.slice(8)), weekend: weekdayIndex(date) >= 5 });
			if (cells.length === 7) {
				weeks.push({ key: date, cells });
				cells = [];
			}
		}
		if (cells.length > 0) {
			while (cells.length < 7) cells.push(undefined);
			weeks.push({ key: `${monthStart}-tail`, cells });
		}
		return { monthStart, label: monthLabel(monthStart), weeks };
	}

	const calendar = $derived(months.map(buildMonth));

	const TARGETS: { key: PaintTarget; name: string }[] = [
		{ key: 'span', name: 'Travel window' },
		{ key: 'latestDeparture', name: 'Leave by' },
		{ key: 'soonestArrival', name: 'Arrive from' }
	];

	function targetValue(key: PaintTarget): string {
		if (key === 'span') return rangeLabel(resolved.departFrom, resolved.arriveTo);
		if (key === 'latestDeparture') {
			return fields.latestDepartureOverride.trim()
				? rangeLabel(fields.latestDepartureOverride.trim(), fields.latestDepartureOverride.trim())
				: 'Any day';
		}
		return fields.soonestArrivalOverride.trim()
			? rangeLabel(fields.soonestArrivalOverride.trim(), fields.soonestArrivalOverride.trim())
			: 'Any day';
	}

	const instruction = $derived.by(() => {
		if (paint.target === 'span') {
			return paint.anchor
				? 'Now tap the other end of your travel window.'
				: 'Tap the first and last day you could be travelling.';
		}
		if (paint.target === 'latestDeparture') {
			return 'Tap the last day you would still set off on. Tap it again to clear it.';
		}
		return 'Tap the first day you could arrive on. Tap it again to clear it.';
	});

	function pick(date: IsoCalendarDate) {
		const next = paintDay(fields, paint, date);
		paint = next.state;
		focusedDate = date;
		onchange(next.fields);
	}

	/** A scroll is motion too. `prefers-reduced-motion` is not only about CSS transitions, and
	 * a smooth scroll is the one bit of motion here that CSS cannot turn off for us. */
	function scrollBehavior(): ScrollBehavior {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
	}

	async function moveFocus(to: IsoCalendarDate) {
		// Never before today (a past date is a search the form refuses to spend) and never
		// past the last month drawn, so an arrow key cannot land focus on nothing.
		const clamped = to < today ? today : to > lastDate ? lastDate : to;
		focusedDate = clamped;
		hovered = clamped;
		await tick();
		const cell = gridEl?.querySelector<HTMLButtonElement>(`[data-date="${clamped}"]`);
		cell?.focus();
		cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	function onKeydown(event: KeyboardEvent) {
		const steps: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			ArrowUp: -7,
			ArrowDown: 7
		};
		const step = steps[event.key];
		if (step !== undefined) {
			event.preventDefault();
			void moveFocus(addDays(focusedDate, step));
			return;
		}
		if (event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			const index = weekdayIndex(focusedDate);
			void moveFocus(addDays(focusedDate, event.key === 'Home' ? -index : 6 - index));
			return;
		}
		if (event.key === 'PageUp' || event.key === 'PageDown') {
			event.preventDefault();
			const direction = event.key === 'PageUp' ? -1 : 1;
			void moveFocus(addDays(focusedDate, direction * (event.shiftKey ? 365 : 28)));
		}
	}

	function scrollMonths(direction: -1 | 1) {
		const strip = gridEl;
		if (!strip) return;
		const panel = strip.querySelector<HTMLElement>('.month');
		const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
		const step = panel ? panel.offsetWidth + gap : strip.clientWidth;
		strip.scrollBy({ left: direction * step, behavior: scrollBehavior() });
	}

	function setOverride(field: 'latestDepartureOverride' | 'soonestArrivalOverride', value: string) {
		onchange({ ...fields, [field]: value });
	}
</script>

<div class="dates">
	<div class="dates-head">
		<h3 id="date-window-heading">When</h3>
		<ul class="legend">
			<li><span class="swatch swatch-depart" aria-hidden="true"></span>Could leave</li>
			<li><span class="swatch swatch-arrive" aria-hidden="true"></span>Could arrive</li>
			<li><span class="swatch swatch-span" aria-hidden="true"></span>Away</li>
		</ul>
		<div class="paging">
			<button type="button" class="page-months" onclick={() => scrollMonths(-1)}>
				<span class="visually-hidden">Show earlier months</span>
				<Icon name="chevron-left" />
			</button>
			<button type="button" class="page-months" onclick={() => scrollMonths(1)}>
				<span class="visually-hidden">Show later months</span>
				<Icon name="chevron-right" />
			</button>
		</div>
	</div>

	<div class="targets" role="group" aria-label="What a tap on the calendar sets">
		{#each TARGETS as target (target.key)}
			<button
				type="button"
				class={['target', { 'is-armed': paint.target === target.key }]}
				aria-pressed={paint.target === target.key}
				onclick={() => (paint = armTarget(target.key))}
			>
				<span class="target-name">{target.name}</span>
				<span class="target-value font-mono">{targetValue(target.key)}</span>
				{#if target.key === 'span'}
					<span class="target-note">{spanLength(resolved.departFrom, resolved.arriveTo)}</span>
				{/if}
			</button>
		{/each}
	</div>

	<p class="instruction" aria-live="polite">{instruction}</p>

	<div class="strip">
		<div bind:this={gridEl} class="months scroll-x">
			{#each calendar as month (month.monthStart)}
				<!-- The keyboard belongs to the grid, not to the box that scrolls it. The
				     mouse leaving has to drop the preview, or a half-drawn window keeps
				     painting to wherever the pointer last was. -->
				<table
					class="month"
					role="grid"
					aria-labelledby="date-window-heading"
					onkeydown={onKeydown}
					onmouseleave={() => (hovered = undefined)}
				>
					<caption class="month-name">{month.label}</caption>
					<thead>
						<tr>
							{#each WEEKDAYS as weekday (weekday.short)}
								<th scope="col" abbr={weekday.long}>{weekday.short}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each month.weeks as week (week.key)}
							<tr>
								{#each week.cells as cell, index (index)}
									{#if !cell}
										<td class="pad"></td>
									{:else if cell.date < today}
										<td class="past"><span aria-hidden="true">{cell.day}</span></td>
									{:else}
										{@const mark = markDay(cell.date, drawn)}
										<td>
											<button
												type="button"
												data-date={cell.date}
												class={['day', { 'in-span': mark.inSpan, 'is-weekend': cell.weekend, 'is-today': cell.date === today }]}
												tabindex={cell.date === focusedDate ? 0 : -1}
												aria-label={describeDay(mark)}
												aria-pressed={mark.depart !== 'none' || mark.arrive !== 'none'}
												onclick={() => pick(cell.date)}
												onmouseenter={() => (hovered = cell.date)}
												onfocus={() => (hovered = cell.date)}
											>
												<span class="rail rail-depart" data-pos={mark.depart} aria-hidden="true"></span>
												<span class="day-number font-mono">{cell.day}</span>
												<span class="rail rail-arrive" data-pos={mark.arrive} aria-hidden="true"></span>
											</button>
										</td>
									{/if}
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			{/each}
		</div>
	</div>

	<div class="typed">
		<div class="typed-field">
			<label for={FIELD_INPUT_ID.soonestDeparture}>Soonest departure <span aria-hidden="true">*</span></label>
			<input
				id={FIELD_INPUT_ID.soonestDeparture}
				type="date"
				autocomplete="off"
				required
				min={today}
				value={fields.soonestDeparture}
				aria-invalid={errors.soonestDeparture ? 'true' : undefined}
				class={['date-input', { 'has-error': !!errors.soonestDeparture }]}
				oninput={(event) => onchange({ ...fields, soonestDeparture: event.currentTarget.value })}
				onblur={() => ontouch('soonestDeparture')}
			/>
			{#if errors.soonestDeparture}
				<p class="date-error" role="alert">{errors.soonestDeparture}</p>
			{/if}
		</div>

		<div class="typed-field">
			<label for={FIELD_INPUT_ID.latestDepartureOverride}>Latest departure</label>
			<div class="typed-row">
				<input
					id={FIELD_INPUT_ID.latestDepartureOverride}
					type="date"
					autocomplete="off"
					min={fields.soonestDeparture || today}
					max={fields.latestArrival || undefined}
					value={fields.latestDepartureOverride}
					aria-invalid={errors.latestDepartureOverride ? 'true' : undefined}
					aria-describedby="latest-departure-note"
					class={['date-input', { 'has-error': !!errors.latestDepartureOverride }]}
					oninput={(event) => setOverride('latestDepartureOverride', event.currentTarget.value)}
					onblur={() => ontouch('latestDepartureOverride')}
				/>
				{#if fields.latestDepartureOverride.trim()}
					<button type="button" class="clear" onclick={() => setOverride('latestDepartureOverride', '')}>
						Any day
					</button>
				{/if}
			</div>
			{#if errors.latestDepartureOverride}
				<p class="date-error" role="alert">{errors.latestDepartureOverride}</p>
			{:else}
				<p id="latest-departure-note" class="note">
					{#if fields.latestDepartureOverride.trim()}
						You would set off on this day at the latest.
					{:else}
						Any day up to your latest arrival.
					{/if}
				</p>
			{/if}
		</div>

		<div class="typed-field">
			<label for={FIELD_INPUT_ID.soonestArrivalOverride}>Soonest arrival</label>
			<div class="typed-row">
				<input
					id={FIELD_INPUT_ID.soonestArrivalOverride}
					type="date"
					autocomplete="off"
					min={fields.soonestDeparture || today}
					max={fields.latestArrival || undefined}
					value={fields.soonestArrivalOverride}
					aria-invalid={errors.soonestArrivalOverride ? 'true' : undefined}
					aria-describedby="soonest-arrival-note"
					class={['date-input', { 'has-error': !!errors.soonestArrivalOverride }]}
					oninput={(event) => setOverride('soonestArrivalOverride', event.currentTarget.value)}
					onblur={() => ontouch('soonestArrivalOverride')}
				/>
				{#if fields.soonestArrivalOverride.trim()}
					<button type="button" class="clear" onclick={() => setOverride('soonestArrivalOverride', '')}>
						Any day
					</button>
				{/if}
			</div>
			{#if errors.soonestArrivalOverride}
				<p class="date-error" role="alert">{errors.soonestArrivalOverride}</p>
			{:else}
				<p id="soonest-arrival-note" class="note">
					{#if fields.soonestArrivalOverride.trim()}
						You would not land before this day.
					{:else}
						Any day from your soonest departure.
					{/if}
				</p>
			{/if}
		</div>

		<div class="typed-field">
			<label for={FIELD_INPUT_ID.latestArrival}>Latest arrival <span aria-hidden="true">*</span></label>
			<input
				id={FIELD_INPUT_ID.latestArrival}
				type="date"
				autocomplete="off"
				required
				min={fields.soonestDeparture || today}
				value={fields.latestArrival}
				aria-invalid={errors.latestArrival ? 'true' : undefined}
				class={['date-input', { 'has-error': !!errors.latestArrival }]}
				oninput={(event) => onchange({ ...fields, latestArrival: event.currentTarget.value })}
				onblur={() => ontouch('latestArrival')}
			/>
			{#if errors.latestArrival}
				<p class="date-error" role="alert">{errors.latestArrival}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	/* This control renders both full width on the search screen and inside a narrower panel
	   above the results, so its own width decides its layout. A viewport media query would
	   give the results page a three-across chip row it has no room for. */
	.dates {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.dates-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-4);
	}

	h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		line-height: var(--line-height-lg);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
	}

	/* The two rails are the same colour on purpose, so the legend carries the difference in
	   the same shapes the cells use rather than in two words about gold.
	   Narrow: it takes a row of its own under the heading, leaving the heading and the two
	   arrows on the top line. Letting it sit inline pushed the arrows onto a line of their
	   own, hard left, under a right-aligned legend. */
	.legend {
		display: flex;
		flex: 1 1 100%;
		order: 3;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: 0;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.swatch {
		position: relative;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 2px;
		background: var(--color-accent-muted);
	}

	.swatch-depart::before,
	.swatch-arrive::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 4px;
		border-radius: 2px;
		background: var(--color-accent);
	}

	.swatch-depart::before {
		top: 0;
	}

	.swatch-arrive::before {
		bottom: 0;
	}

	.targets {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-2);
	}

	.target {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: var(--control-height);
		padding: var(--space-2) var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		text-align: left;
		cursor: pointer;
		touch-action: manipulation;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.target:hover {
		background: var(--color-surface-hover);
	}

	.target.is-armed {
		background: var(--color-accent-muted);
		border-color: var(--color-accent);
	}

	.target-name {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.target.is-armed .target-name {
		color: var(--color-accent);
	}

	.target-value {
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text);
	}

	.target-note {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
	}

	.instruction {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
	}

	.strip {
		min-width: 0;
	}

	/* Above the months rather than either side of them. Flanking arrows cost about 64px of
	   the 375px screen, which is two days of calendar, and they are the one place this
	   layout could not spare them. */
	.paging {
		display: flex;
		gap: var(--space-1);
		margin-inline-start: auto;
	}

	.page-months {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--control-height);
		min-height: var(--control-height);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		cursor: pointer;
		touch-action: manipulation;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.page-months :global(svg) {
		width: 1rem;
		height: 1rem;
	}

	.page-months:hover {
		background: var(--color-surface-hover);
		border-color: var(--color-border-strong);
		color: var(--color-text);
	}

	/* A filmstrip of months, one per phone screen and four across a desktop, rather than a
	   year stacked vertically. Wide content scrolls inside its own box, never the page, and
	   `overscroll-behavior` keeps a flick that runs off the end of December from turning into
	   a page scroll under the traveller's thumb. */
	.months {
		display: flex;
		gap: var(--space-4);
		scroll-snap-type: x mandatory;
		overscroll-behavior-x: contain;
		padding-bottom: var(--space-2);
	}

	/* `table-layout: fixed` is load bearing, not tidiness. Left to size themselves the seven
	   columns take their width from their content, so the column holding "31" is wider than
	   the one holding "1", the rails under them are different lengths, and an interval stops
	   reading as a straight line. Auto layout is also how #268's strip segments collapsed to
	   two pixels while every test still passed. */
	.month {
		flex: 0 0 auto;
		/* A phone gets exactly one month per screen, which both makes the snap land cleanly
		   and buys the day cells the width to be 44px targets. A sliver of the next month
		   showing is a worse affordance than the arrows above, and it costs four pixels a
		   day across the row. */
		width: 100%;
		max-width: 21rem;
		table-layout: fixed;
		border-collapse: collapse;
		scroll-snap-align: start;
	}

	.month-name {
		padding-bottom: var(--space-2);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		text-align: left;
		color: var(--color-text);
	}

	th {
		padding-bottom: var(--space-1);
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-faint);
	}

	td {
		padding: 0;
	}

	.past span {
		display: flex;
		align-items: center;
		justify-content: center;
		height: var(--day-size);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		opacity: 0.55;
	}

	/* No gap between cells and rails that reach both edges, so a window reads as one
	   continuous interval rather than as a row of separately selected days. */
	.day {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: var(--day-size);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		/* Days get tapped several times in a row. Without this the browser waits to see
		   whether each one was a double-tap zoom, and the calendar feels a beat behind. The
		   tap flash goes too: the default blue has nothing to do with this palette. */
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		transition: background-color var(--transition-fast);
	}

	.day.is-weekend {
		color: var(--color-text-faint);
	}

	.day:hover {
		background: var(--color-surface-hover);
	}

	.day:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	.day.in-span {
		background: var(--color-accent-muted);
		color: var(--color-text);
	}

	/* A day already in the window still has to answer the pointer. `.day:hover` alone lost to
	   `.day.in-span` on source order, so every selected day was the one part of the calendar
	   that did not react to being hovered. */
	.day.in-span:hover {
		box-shadow: inset 0 0 0 1px var(--color-accent);
	}

	.day-number {
		font-size: var(--font-size-sm);
		font-variant-numeric: tabular-nums;
	}

	.day.is-today .day-number {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-full);
		box-shadow: inset 0 0 0 1px var(--color-border-strong);
	}

	.rail {
		position: absolute;
		left: 0;
		right: 0;
		height: 5px;
		background: var(--color-accent);
	}

	.rail[data-pos='none'] {
		display: none;
	}

	.rail-depart {
		top: 3px;
	}

	.rail-arrive {
		bottom: 3px;
	}

	/* Caps only at a window's real ends, so the middle of an interval runs unbroken into
	   the next day and a single-day window reads as one pill. */
	.rail[data-pos='start'] {
		border-start-start-radius: 3px;
		border-end-start-radius: 3px;
		left: 3px;
	}

	.rail[data-pos='end'] {
		border-start-end-radius: 3px;
		border-end-end-radius: 3px;
		right: 3px;
	}

	.rail[data-pos='only'] {
		left: 3px;
		right: 3px;
		border-radius: 3px;
	}

	/* One column until there is genuinely room for two. A `dd/mm/yyyy` box plus the browser's
	   own calendar button needs about 160px before it starts truncating the year, and at 375
	   two columns give it 145. The date read "10/(" on a phone until this was one column. */
	.typed {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px dashed var(--color-border);
	}

	.typed-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}

	.typed-field label {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.typed-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.date-input {
		width: 100%;
		min-width: 0;
		min-height: var(--control-height);
		padding: var(--control-padding-y) var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
		color: var(--color-text);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-sm);
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.date-input:focus-visible {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.date-input.has-error {
		border-color: var(--color-danger);
	}

	.clear {
		flex: 0 0 auto;
		min-height: var(--control-height);
		padding-inline: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		cursor: pointer;
	}

	.clear:hover {
		color: var(--color-text);
		border-color: var(--color-border-strong);
	}

	.note {
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-faint);
	}

	.date-error {
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		color: var(--color-danger);
	}

	@container (min-width: 26rem) {
		.typed {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@container (min-width: 34rem) {
		.month {
			width: 17.5rem;
		}

		.targets {
			grid-template-columns: 1.4fr 1fr 1fr;
		}

		.legend {
			flex: 0 1 auto;
			order: 2;
			margin-inline-start: auto;
		}

		.paging {
			margin-inline-start: 0;
		}
	}

	@container (min-width: 56rem) {
		.typed {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.day,
		.target {
			transition: none;
		}
	}
</style>
