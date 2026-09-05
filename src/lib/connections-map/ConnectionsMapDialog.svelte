<script lang="ts">
	/**
	 * Every connection between two airports, on one map, with what each stopover is worth
	 * beside it. Issue #324.
	 *
	 * The owner: **"i would like to be able to see a map with all the connections avilable
	 * between two airports with their itineraries marked and tooltip when hover that says
	 * name of connection, flight time (total and per each segement), itinerary price (if
	 * avilable, if no viable flight combination indicate it and make the map line different),
	 * airlines that do the flights, calendar with days that have flights and days that dont.
	 * the tooltip should not keep visible if mouse goes over it, so i can make the tooltip
	 * change on points inthe map that are close, also consider using a sidebar."**
	 *
	 * ## The sidebar, and why there is no rich tooltip
	 *
	 * Those two sentences pull in opposite directions, and the second one resolves the first.
	 *
	 * A tooltip that vanishes when the pointer moves onto it is the exact opposite of WCAG
	 * 2.1 SC 1.4.13, whose Hoverable condition reads: "If pointer hover can trigger the
	 * additional content, then the pointer can be moved over the additional content without
	 * the additional content disappearing." It is also the opposite of what `SegmentStub`
	 * does in this codebase today, holding a 150ms grace precisely so a reader can move onto
	 * the panel. Both behaviours are right for different jobs. Sweeping a dense map wants the
	 * owner's; reading a panel wants the other.
	 *
	 * The way out is the sidebar the owner himself raised, and it is not a compromise between
	 * the two. SC 1.4.13 opens by scoping itself: "This criterion applies to content that
	 * appears in addition to the triggering component itself." A panel that is on screen
	 * before the pointer moves, stays on screen after it leaves, and only changes what it
	 * says, is not additional content that appears and disappears. There is nothing under the
	 * pointer to be hoverable about, so the conflict dissolves rather than being traded away.
	 * The owner gets exactly the sweep he asked for, and the panel holds far more than a
	 * tooltip could: both flights' times and airlines, the layover against his own minimum,
	 * the nights, the detour, whether a bed was priced, and a calendar per leg.
	 *
	 * This is also the arrangement accommodation and flight search settled on for the same
	 * reason. Airbnb's split view highlights the map pin when the pointer crosses a list row;
	 * this is that relationship, driven from the map side as well as the list side.
	 *
	 * So: **a sidebar, and no rich tooltip.** The only thing hovering a point produces of its
	 * own is the browser's native `title`, which SC 1.4.13 exempts by name because its
	 * presentation belongs to the user agent.
	 *
	 * ## Preview, pin, and why they are two variables
	 *
	 * `previewCode` is whatever the pointer or the keyboard is currently on. `pinnedCode` is
	 * what a click left behind. The panel shows `previewCode ?? pinnedCode`, so sweeping
	 * across five cities shows five answers and moving the pointer away restores the one the
	 * traveller chose to keep. Collapsing them into one variable would mean either the sweep
	 * destroys the pin or the pin blocks the sweep, and the owner asked for both.
	 *
	 * Only a pin moves the camera. A sweep that flew the map a dozen times would leave the
	 * traveller somewhere they never asked to be, which is the opposite of comparing.
	 *
	 * ## Nothing here spends a request
	 *
	 * The connections, their itineraries and their refusals all come off the search snapshot
	 * the results page already has. The calendars are a read of `$lib/flexible-dates`'s
	 * IndexedDB cache, lazily and only for the connection on screen. No provider is called to
	 * draw this screen, metered or free.
	 */
	import { MapDialog } from '$lib/components';
	import type { IataAirportCode } from '$lib/domain';
	import { formatMoney } from '$lib/format';
	import ConnectionsMap from './ConnectionsMap.svelte';
	import ConnectionsPanel from './ConnectionsPanel.svelte';
	import { readConnectionCalendar, type CalendarWindow, type ConnectionCalendar } from './calendar';
	import { summariseConnections } from './copy';
	import { countByState, type ConnectionsMapModel } from './model';

	interface Props {
		model: ConnectionsMapModel;
		/** The dates the calendar strips cover: the search's own window. */
		window: CalendarWindow;
		/** Currency every leg's cached fares are read in. The same one the search asked every
		 * provider for, so the ledger lookup finds what the search wrote. */
		currency: string;
		/** Opens the results card for a stopover. The parent closes this dialog. */
		onopen: (code: IataAirportCode) => void;
		/** `SearchQuery.airlinesToAvoid`, upper-cased. Only ever quiets a logo and adds a
		 * line; the brief is explicit that an avoided airline is still shown. */
		avoidedCarriers?: ReadonlySet<string>;
		/**
		 * Issue #350: `SearchSnapshot.confirmedBeyondCap` — stopovers candidate discovery
		 * confirmed on both flights and then dropped, because the candidate cap was full.
		 *
		 * A prop rather than a field on `ConnectionsMapModel`, because none of these is drawn.
		 * That model is the picture, and every field on it is a coordinate, a distance or a
		 * state a point renders in; an airport with no arc and no point does not belong in it.
		 * The panel's opening line is a sentence about the search, which is where this fits.
		 */
		confirmedBeyondCap?: readonly IataAirportCode[];
		onclose: () => void;
	}

	let {
		model,
		window: dateWindow,
		currency,
		onopen,
		onclose,
		avoidedCarriers = new Set<string>(),
		confirmedBeyondCap = []
	}: Props = $props();

	let previewCode = $state<IataAirportCode | null>(null);
	let pinnedCode = $state<IataAirportCode | null>(null);

	const shownCode = $derived(previewCode ?? pinnedCode);
	const shown = $derived(model.connections.find((connection) => connection.airport.iataCode === shownCode));
	const summary = $derived(summariseConnections(countByState(model), confirmedBeyondCap));

	const priceLabels = $derived.by(() => {
		const labels: Partial<Record<IataAirportCode, string>> = {};
		for (const connection of model.connections) {
			if (connection.state !== 'bookable' && connection.state !== 'part-priced') continue;
			labels[connection.airport.iataCode] = formatMoney(connection.trip.best.score.itinerary.totalPrice);
		}
		return labels;
	});

	/**
	 * Calendars already read, by connection code. A plain `SvelteMap` rather than a fetch per
	 * render: a sweep crosses a dozen connections in a second and each read is several
	 * IndexedDB gets, so the second look at a city costs nothing.
	 *
	 * `$state` on the map itself, not on its contents, because the values are plain snapshots
	 * that are written once and never mutated.
	 */
	let calendars = $state<Record<string, ConnectionCalendar>>({});
	/**
	 * Which codes have been asked for, so a sweep back across a city already read costs
	 * nothing.
	 *
	 * A plain `Set` and NOT a `SvelteSet`, deliberately, and the Svelte autofixer will keep
	 * suggesting otherwise. Reactive membership is exactly the wrong thing here: the effect
	 * below reads `requested.has(code)` and writes `requested.add(code)`, so a reactive Set
	 * would make that effect read and write its own dependency, which is the
	 * `effect_update_depth_exceeded` shape AGENTS.md records as having frozen every search in
	 * production (#87). Nothing renders from this, so it has no business being reactive.
	 */
	const requested = new Set<string>();

	const shownCalendar = $derived(shownCode ? calendars[shownCode] : undefined);

	// The async work is started with the reactive read already done and the write guarded by
	// `requested`, so this effect never reads the state it writes. AGENTS.md records what the
	// other shape did to production (#87): an `$effect` whose unawaited call synchronously
	// touches its own dependency retriggers itself until Svelte aborts the page.
	$effect(() => {
		const code = shownCode;
		if (!code || requested.has(code)) return;
		requested.add(code);
		void readConnectionCalendar({
			originAirport: model.originAirport.iataCode,
			connectionAirport: code,
			destinationAirport: model.destinationAirport.iataCode,
			currency,
			window: dateWindow
		}).then((calendar) => {
			calendars = { ...calendars, [code]: calendar };
		});
	});

	const title = $derived(
		`Connections from ${model.originAirport.city.name} to ${model.destinationAirport.city.name}`
	);

	function pin(code: IataAirportCode): void {
		// A second click on the pinned city clears it and returns the camera to the whole
		// picture, which is the only way back out without reaching for a separate control.
		pinnedCode = pinnedCode === code ? null : code;
	}
</script>

<MapDialog {title} {onclose} class="connections-dialog">
	{#snippet panel()}
		<ConnectionsPanel
			{model}
			{shown}
			{pinnedCode}
			{summary}
			calendar={shownCalendar}
			onpreview={(code) => (previewCode = code)}
			onpin={pin}
			{onopen}
			{avoidedCarriers}
		/>
	{/snippet}
	{#snippet map()}
		<ConnectionsMap
			{model}
			{shownCode}
			{pinnedCode}
			{priceLabels}
			onpreview={(code) => (previewCode = code)}
			onpin={pin}
		/>
	{/snippet}
</MapDialog>
