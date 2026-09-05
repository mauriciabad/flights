<script lang="ts">
	/**
	 * The whole search, as one component, so the search screen and the results screen
	 * are editing the same thing rather than two forms that drift apart.
	 *
	 * It was inline in `src/routes/+page.svelte` while Search and Results were two peer
	 * tabs. The owner on that: "the UX of goig from search to result makes no fucking
	 * sense. you should get redirected [...] results should be merged with search, you
	 * first pick the search and then shows results, they are not 2 separate tabs." So
	 * this now lives in `$lib` and the results page opens it in place, above its own
	 * results, with the current query already in it.
	 *
	 * Issue #277 rebuilt the layout. It used to be five stacked cards in a narrow column
	 * with two `<details>` hiding four fields, which is what the owner objected to: "i also
	 * dont like that fields are collapsed, i like everything to be shown. the screen is big,
	 * we can use full width on desktop to fit more elements in 1 screen". Nothing collapses
	 * now, and the panel below is one surface divided by hairlines rather than a stack of
	 * boxes, because five cards around five short groups is four fifths chrome.
	 *
	 * Width decides the layout, not the viewport: this same form renders full width on the
	 * search screen and inside a narrower panel above the results, so it is a container
	 * query container and every breakpoint below is about the space this form actually got.
	 *
	 * Field ids are fixed by `FIELD_INPUT_ID` (validation.ts) rather than generated,
	 * because a failed submit has to move focus to the first field that is wrong and an
	 * error summary has to link to it. One consequence: only one of these may be on a
	 * page at a time, which is the case on both screens that use it.
	 */
	import { tick, untrack } from 'svelte';
	import { Button } from '$lib/components';
	import {
		DEFAULT_LANDING_TO_TRANSPORT_RULES,
		DEFAULT_MIN_LAYOVER_TIME_MINUTES,
		DEFAULT_TRAVELLERS,
		DEFAULT_WAITING_TIME_RULES
	} from '$lib/domain';
	import AirportField from './AirportField.svelte';
	import ChipListField from './ChipListField.svelte';
	import CountField from './CountField.svelte';
	import DateWindowPicker from './DateWindowPicker.svelte';
	import LocationField from './LocationField.svelte';
	import MinutesField from './MinutesField.svelte';
	import type { DateWindowFields } from './date-window';
	import type { SearchFormFields } from './model';
	import TieredDurationField from './TieredDurationField.svelte';
	import {
		landingToTransportRulesToRows,
		rowsToLandingToTransportRules,
		rowsToWaitingTimeRules,
		waitingTimeRulesToRows,
		type TieredRuleRow
	} from './tiered-rules';
	import { fieldsToSearchParams } from './url-codec';
	import {
		FIELD_INPUT_ID,
		issuesByField,
		validateSearchFields,
		type SearchFieldKey
	} from './validation';

	interface Props {
		/** Seeded once. The parent re-keys this component when the URL's search changes,
		 * rather than pushing new values in, so nothing here fights the traveller for
		 * ownership of a field they are typing in. */
		initialFields: SearchFormFields;
		/** Today's calendar date, `YYYY-MM-DD`. The parent owns the clock. */
		today: string;
		submitLabel?: string;
		/** Handed the URL params of a search that passed validation, so the caller only
		 * ever has to decide where to navigate. */
		onsearch: (params: URLSearchParams) => void;
		/** Rendered as a second button when given, for the results page's editor. */
		oncancel?: () => void;
		/** Show every problem straight away instead of waiting for a blur or a submit.
		 * Set when the form opens because the search it was given is already wrong, which
		 * is the results page arriving on a link nobody could have run. */
		revealIssues?: boolean;
	}

	let {
		initialFields,
		today,
		submitLabel = 'Search flights',
		onsearch,
		oncancel,
		revealIssues = false
	}: Props = $props();

	// `untrack` says the "seeded once" above out loud to the compiler: this deliberately
	// captures the initial value and never follows the prop afterwards.
	let fields = $state<SearchFormFields>(untrack(() => ({ ...initialFields })));

	// Number inputs go through a raw string buffer rather than binding `fields.*`
	// directly: an in-progress "" (cleared field) has to stay distinct from "0", and a
	// plain `bind:value` on a numeric prop cannot tell those apart.
	let travellersRaw = $state(fields.travellers !== undefined ? String(fields.travellers) : '');
	let femalesRaw = $state(fields.females !== undefined ? String(fields.females) : '');
	let minLayoverRaw = $state(
		fields.minLayoverTime !== undefined ? String(fields.minLayoverTime) : ''
	);

	/**
	 * `undefined` for blank, `NaN` for text that is not a number, otherwise the number
	 * exactly as typed. It used to clamp ("0 travellers" silently became 1 and "abc"
	 * silently vanished), which is the class of thing the owner asked to stop: a field
	 * that can be wrong should say so rather than quietly correct itself. `validation.ts`
	 * turns both odd values into a sentence in the field.
	 */
	function parseNumberField(raw: string): number | undefined {
		// `String(raw ?? '')` rather than `raw.trim()`: Svelte's `bind:value` checks the
		// element's type at runtime and hands back a `number` (or `null` when empty) for
		// `<input type="number">`, whatever the prop's declared type says. The old code
		// here called `.trim()` straight on it, so the first keystroke in "Number of
		// people" threw a TypeError inside the derived and the form silently stopped
		// validating anything at all.
		const trimmed = String(raw ?? '').trim();
		if (!trimmed) return undefined;
		return Number(trimmed);
	}

	let waitingRows = $state<TieredRuleRow[]>(
		waitingTimeRulesToRows(fields.waitingTimeRules ?? DEFAULT_WAITING_TIME_RULES)
	);
	let transportRows = $state<TieredRuleRow[]>(
		landingToTransportRulesToRows(
			fields.landingToTransportRules ?? DEFAULT_LANDING_TO_TRANSPORT_RULES
		)
	);

	/** `fields` plus everything the raw buffers and row editors resolve to. Computed, not
	 * written back into `fields`, so nothing fights Svelte over who owns a field. */
	const effectiveFields = $derived<SearchFormFields>({
		...fields,
		travellers: parseNumberField(travellersRaw),
		females: parseNumberField(femalesRaw),
		minLayoverTime: parseNumberField(minLayoverRaw),
		waitingTimeRules: rowsToWaitingTimeRules(waitingRows),
		landingToTransportRules: rowsToLandingToTransportRules(transportRows)
	});

	const issues = $derived(validateSearchFields(effectiveFields, { today }));
	const allMessages = $derived(issuesByField(issues));

	/**
	 * A field says what is wrong with it once the traveller has left it, or once they
	 * have tried to search. Nothing shouts at a half-typed airport code.
	 */
	let attempted = $state(untrack(() => revealIssues));
	let touched = $state<Record<string, boolean>>({});
	const errors = $derived.by(() => {
		const shown: Partial<Record<SearchFieldKey, string>> = {};
		for (const [field, message] of Object.entries(allMessages) as [SearchFieldKey, string][]) {
			if (attempted || touched[field]) shown[field] = message;
		}
		return shown;
	});

	function markTouched(field: SearchFieldKey) {
		touched = { ...touched, [field]: true };
	}

	/** The summary lists only what is on screen, so it can never name an error the
	 * traveller cannot see. After a submit attempt that is everything. */
	const summaryIssues = $derived(issues.filter((issue) => errors[issue.field] === issue.message));

	let summaryEl = $state<HTMLDivElement | undefined>();

	/** The four dates as the calendar's own shape. It writes all four back at once, since
	 * one tap can move a required date and drop an interior cut in the same gesture. */
	const dateFields = $derived<DateWindowFields>({
		soonestDeparture: fields.soonestDeparture,
		latestDepartureOverride: fields.latestDepartureOverride,
		latestArrival: fields.latestArrival,
		soonestArrivalOverride: fields.soonestArrivalOverride
	});

	function setDates(next: DateWindowFields) {
		fields.soonestDeparture = next.soonestDeparture;
		fields.latestDepartureOverride = next.latestDepartureOverride;
		fields.latestArrival = next.latestArrival;
		fields.soonestArrivalOverride = next.soonestArrivalOverride;
	}

	function focusField(field: SearchFieldKey) {
		document.getElementById(FIELD_INPUT_ID[field])?.focus();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		attempted = true;
		if (issues.length > 0) {
			// One frame for the summary to render before it is focused, otherwise the
			// screen reader is sent to an element that does not exist yet.
			await tick();
			summaryEl?.focus();
			return;
		}
		onsearch(fieldsToSearchParams(effectiveFields));
	}

	function swapAirports() {
		const from = fields.originAirport;
		fields.originAirport = fields.destinationAirport;
		fields.destinationAirport = from;
	}

	const upperCode = (length: number) => (raw: string) => {
		const token = raw.trim().toUpperCase();
		return token.length === length ? token : null;
	};
	const airportToken = upperCode(3);
	const countryToken = upperCode(2);
	const airlineToken = upperCode(2);

	/** The layover answers people actually give, in the order they give them. The box beside
	 * them still takes any number of minutes at all. */
	const LAYOVER_PRESETS = [30, 45, 60, 90, 120];
</script>

<form novalidate onsubmit={handleSubmit} class="search-form">
	{#if summaryIssues.length > 0}
		<!-- The pattern every accessible form uses and this one did not: one summary at
		     the top, focused on a failed submit, each line a link straight to the field
		     it is about. The old form said "A few required fields are missing" and left
		     the traveller to find out which. -->
		<div
			bind:this={summaryEl}
			class="error-summary"
			role="alert"
			tabindex="-1"
			aria-labelledby="error-summary-title"
		>
			<p id="error-summary-title" class="error-summary-title">
				{summaryIssues.length === 1
					? 'One thing to fix before this search can run'
					: `${summaryIssues.length} things to fix before this search can run`}
			</p>
			<ul>
				{#each summaryIssues as issue (issue.field + issue.message)}
					<li>
						<a
							href={`#${FIELD_INPUT_ID[issue.field]}`}
							onclick={(event) => {
								event.preventDefault();
								focusField(issue.field);
							}}
						>
							{issue.message}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="panel">
		<section class="region region-route" aria-labelledby="region-route-title">
			<h2 id="region-route-title">Route</h2>
			<div class="route">
				<AirportField
					label="Origin airport"
					id={FIELD_INPUT_ID.originAirport}
					required
					bind:value={fields.originAirport}
					error={errors.originAirport}
					onblur={() => markTouched('originAirport')}
					class="route-from"
				/>
				<button type="button" class="swap" onclick={swapAirports}>
					<span class="swap-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none">
							<path
								d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
					<span class="swap-label">Swap</span>
				</button>
				<AirportField
					label="Destination airport"
					id={FIELD_INPUT_ID.destinationAirport}
					required
					bind:value={fields.destinationAirport}
					error={errors.destinationAirport}
					onblur={() => markTouched('destinationAirport')}
					class="route-to"
				/>
				<!-- One short hint each. The component's default is a sentence about naming a
				     place or using your device position, and printing it twice, two lines
				     each, spent four lines of the panel saying one thing. -->
				<LocationField
					label="Start point"
					hint="Where the trip starts, if not the airport."
					bind:value={fields.originLocation}
					class="route-from-place"
				/>
				<LocationField
					label="End point"
					hint="Where it ends, if not the airport."
					bind:value={fields.destinationLocation}
					class="route-to-place"
				/>
			</div>
		</section>

		<section class="region region-party" aria-labelledby="region-party-title">
			<h2 id="region-party-title">Who is travelling</h2>
			<div class="party">
				<CountField
					label="People"
					id={FIELD_INPUT_ID.travellers}
					bind:value={travellersRaw}
					fallback={DEFAULT_TRAVELLERS}
					min={1}
					placeholder={String(DEFAULT_TRAVELLERS)}
					hint="Defaults to 1."
					error={errors.travellers}
					onblur={() => markTouched('travellers')}
				/>
				<CountField
					label="Of them female"
					id={FIELD_INPUT_ID.females}
					bind:value={femalesRaw}
					fallback={0}
					min={0}
					placeholder="Any"
					hint="Only checks whether female-only dorms fit your group. It never affects pricing."
					error={errors.females}
					onblur={() => markTouched('females')}
				/>
			</div>
		</section>

		<section class="region region-dates" aria-labelledby="date-window-heading">
			<DateWindowPicker
				fields={dateFields}
				{today}
				{errors}
				onchange={setDates}
				ontouch={markTouched}
			/>
		</section>

		<section class="region region-connections" aria-labelledby="region-connections-title">
			<h2 id="region-connections-title">Connections</h2>
			<MinutesField
				label="Minimum layover time"
				id={FIELD_INPUT_ID.minLayoverTime}
				bind:value={minLayoverRaw}
				presets={LAYOVER_PRESETS}
				fallback={DEFAULT_MIN_LAYOVER_TIME_MINUTES}
				hint="Time between the two flights. Not the same as time at the airport."
				error={errors.minLayoverTime}
				onblur={() => markTouched('minLayoverTime')}
			/>
			<div class="lists">
				<ChipListField
					label="Only these connection airports"
					id={FIELD_INPUT_ID.allowedConnectionAirports}
					hint="IATA codes, for example VIE. Empty allows any."
					placeholder="Add a code and press enter"
					rejectMessage="An airport code is three letters, like VIE."
					transform={airportToken}
					bind:values={fields.allowedConnectionAirports}
					error={errors.allowedConnectionAirports}
				/>
				<ChipListField
					label="Never these connection airports"
					id={FIELD_INPUT_ID.forbiddenConnectionAirports}
					hint="IATA codes to rule out entirely."
					placeholder="Add a code and press enter"
					rejectMessage="An airport code is three letters, like VIE."
					transform={airportToken}
					bind:values={fields.forbiddenConnectionAirports}
					error={errors.forbiddenConnectionAirports}
				/>
				<ChipListField
					label="Never these countries"
					id={FIELD_INPUT_ID.forbiddenConnectionCountries}
					hint="ISO country codes, for example RU."
					placeholder="Add a code and press enter"
					rejectMessage="A country code is two letters, like RU."
					transform={countryToken}
					bind:values={fields.forbiddenConnectionCountries}
					error={errors.forbiddenConnectionCountries}
				/>
				<ChipListField
					label="Airlines to avoid"
					id={FIELD_INPUT_ID.airlinesToAvoid}
					hint="Still shown, just greyed out and scored down, never dropped."
					placeholder="Add a code and press enter"
					rejectMessage="An airline code is two characters, like FR or U2."
					transform={airlineToken}
					bind:values={fields.airlinesToAvoid}
					error={errors.airlinesToAvoid}
				/>
			</div>
		</section>

		<section class="region region-ground" aria-labelledby="region-ground-title">
			<h2 id="region-ground-title">Time at the airport</h2>
			<TieredDurationField
				label="Waiting time before a flight"
				hint="How long before departure you want to be at the gate."
				showFlightLength
				bind:rows={waitingRows}
			/>
			<TieredDurationField
				label="Landing to transport"
				hint="How long after landing before you can realistically catch onward transport."
				bind:rows={transportRows}
			/>
		</section>
	</div>

	<div class="actions">
		<Button type="submit" size="lg" fullWidth={!oncancel}>{submitLabel}</Button>
		{#if oncancel}
			<Button type="button" variant="ghost" size="lg" onclick={oncancel}>Cancel</Button>
		{/if}
	</div>
</form>

<style>
	.search-form {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.error-summary {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-5);
		background: var(--color-danger-bg);
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-lg);
	}

	.error-summary:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.error-summary-title {
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	.error-summary ul {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-left: var(--space-4);
		list-style: disc;
	}

	.error-summary a {
		color: var(--color-text);
		font-size: var(--font-size-sm);
	}

	.error-summary a:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	/* One surface with hairlines through it, not five cards. Five boxes around five short
	   groups spends most of the screen on borders, which is the opposite of what the owner
	   asked for. */
	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-sm);
	}

	.region {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
		padding: var(--space-4);
		border-top: 1px solid var(--color-border);
	}

	.region:first-child {
		border-top: 0;
	}

	h2 {
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
	}

	.route {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.party {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.lists {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.swap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		align-self: start;
		min-height: var(--control-height);
		min-width: var(--control-height);
		padding-inline: var(--space-3);
		background: var(--color-surface);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-full);
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		cursor: pointer;
		transition:
			color var(--transition-fast),
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.swap:hover {
		color: var(--color-text);
		background: var(--color-surface-hover);
		border-color: var(--color-accent);
	}

	.swap:active {
		transform: scale(0.96);
	}

	.swap-icon svg {
		width: 1.25rem;
		height: 1.25rem;
		display: block;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.actions :global(.btn) {
		flex: 1 1 12rem;
	}

	/* Two across as soon as there is room for two 44px fields side by side. */
	@container (min-width: 30rem) {
		/* Top-aligned, not bottom-aligned. Bottom alignment looked identical until one of the
		   two airports had an error under it, at which point that field grew downwards and
		   shoved its own input above the other one. Errors now grow into the space below,
		   where they belong, and the two inputs stay on one line. */
		.route {
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
			align-items: start;
		}

		.swap {
			/* Drops past the label above the inputs so it lands on the field line. The two
			   values are `AirportField`'s own label line box and the gap under it. */
			margin-block-start: calc(var(--line-height-sm) + var(--space-2));
			align-self: start;
		}

		.swap-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		.route :global(.route-from-place) {
			grid-column: 1;
		}

		.route :global(.route-to-place) {
			grid-column: 3;
		}

		.lists {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* The desktop shape the owner asked for: route and party on one line, the calendar with
	   the full width it needs under them, then the two rule groups side by side. Deliberately
	   uneven columns rather than a tidy three-across, which is the layout every generated
	   form arrives in. */
	@container (min-width: 64rem) {
		.panel {
			grid-template-columns: repeat(12, minmax(0, 1fr));
		}

		/* Both of these are on the panel's first row here, so neither carries the divider
		   that separates rows. */
		.region-route,
		.region-party {
			border-top: 0;
		}

		.region-route {
			grid-column: span 8;
		}

		.region-party {
			grid-column: span 4;
			border-left: 1px solid var(--color-border);
		}

		.region-dates {
			grid-column: span 12;
		}

		.region-connections {
			grid-column: span 7;
		}

		.region-ground {
			grid-column: span 5;
			border-left: 1px solid var(--color-border);
		}

		.party {
			align-content: start;
		}

		.actions {
			justify-content: flex-end;
		}

		.actions :global(.btn) {
			flex: 0 1 16rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.swap {
			transition: none;
		}
	}
</style>
