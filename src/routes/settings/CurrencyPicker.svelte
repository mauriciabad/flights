<script lang="ts">
	/**
	 * The currency every provider in a search is asked to quote in, chosen here and saved
	 * next to the keys (`keyStore.currency`, `localStorage`, and in the export file so it
	 * travels with a key set).
	 *
	 * A native radio group rather than a `<select>`, for three reasons: twelve options fit
	 * on one screen so there is nothing to hide behind a dropdown, arrow-key navigation and
	 * the "one of these" announcement come free from `<fieldset>` plus `input[type=radio]`,
	 * and a tile is a bigger target than a dropdown row on a phone. The inputs are visually
	 * hidden, never `display: none`, so they stay focusable and keep their semantics.
	 *
	 * Selection is not carried by colour alone (WCAG 1.4.1): the chosen tile also gains a
	 * check mark, which is what survives the greyed-out and high-contrast treatments.
	 *
	 * No `hydrated` gate here, unlike the provider list next door. `keyStore.currency` is
	 * `undefined` on the server and this falls back to `DEFAULT_SEARCH_CURRENCY`, which is
	 * exactly what a search with nothing saved would use, so the prerendered HTML is already
	 * telling the truth. The store hydrates synchronously when the module first runs in the
	 * browser, so a saved non-default currency is correct on the first paint too.
	 */
	import { Card } from '$lib/components';
	import { DEFAULT_SEARCH_CURRENCY } from '$lib/domain';
	import { keyStore } from '$lib/keys';
	import { currencyOptions } from '$lib/settings/currencies';

	const uid = $props.id();
	const headingId = `${uid}-heading`;
	const noteId = `${uid}-note`;

	const selected = $derived(keyStore.currency ?? DEFAULT_SEARCH_CURRENCY);
	const options = $derived(currencyOptions(keyStore.currency));

	function choose(code: string) {
		keyStore.setCurrency(code);
	}
</script>

<Card class="currency-card">
	<h2 id={headingId} class="currency-heading">Currency</h2>

	<!-- A real heading outside the fieldset, and the fieldset named from it: the page's
	     outline gets a section it can list, and the radio group still announces its own
	     name. A <legend> would give one of those, not both. -->
	<fieldset class="currency-fieldset" aria-labelledby={headingId} aria-describedby={noteId}>
		<p class="currency-blurb">
			Every provider is asked to quote in this currency. Nothing here converts a price.
		</p>

		<div class="currency-grid">
			{#each options as option (option.code)}
				<label class="currency-tile">
					<input
						class="currency-input"
						type="radio"
						name="search-currency"
						value={option.code}
						checked={option.code === selected}
						onchange={() => choose(option.code)}
					/>
					<span class="currency-body">
						<span class="currency-symbol" aria-hidden="true">{option.symbol}</span>
						<span class="currency-code">{option.code}</span>
						<span class="currency-name">{option.name}</span>
						<svg class="currency-check" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
							<path
								d="M3 8.4l3.2 3.2L13 5"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
				</label>
			{/each}
		</div>

		<p id={noteId} class="currency-note">
			Asking is not getting. Agoda ranks its hotels before we can name a currency, and taxi
			figures come off a per-country rate card, so those two arrive in whatever they arrive
			in. Any provider can do the same. When one does, that part is left out of the total
			rather than converted at a rate this app made up, which is why a trip can come back
			with its flights priced and its bed missing.
		</p>
	</fieldset>
</Card>

<style>
	/* The compact padding the export/import bar uses, rather than a full provider card's:
	   this is a one-decision utility, not something anyone reads twice. */
	:global(.currency-card.card-padded > .card-body) {
		padding: var(--space-4) var(--space-5);
	}

	.currency-fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

	.currency-heading {
		margin: 0 0 var(--space-2);
		font-size: var(--font-size-base);
	}

	.currency-blurb {
		margin: 0 0 var(--space-4);
		max-width: 60ch;
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
	}

	/* Capped rather than stretched to the page's full 72rem: at full width the twelve tiles
	   land in one row narrow enough to truncate half the currency names, and a name that
	   reads "Australian..." is worse than a second row. */
	.currency-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
		gap: var(--space-2);
		max-width: 58rem;
	}

	/* Three across on a phone: below this the 7rem track would give two fat tiles per row
	   and eighteen rows of scrolling. */
	@media (max-width: 26rem) {
		.currency-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	.currency-tile {
		position: relative;
		display: block;
		min-width: 0;
		cursor: pointer;
	}

	/* Clipped to nothing rather than `display: none` or `visibility: hidden`, both of which
	   take the input out of the tab order and out of the accessibility tree along with it.
	   Positioned against its own tile (hence `position: relative` above), so focusing it
	   with the keyboard scrolls that tile into view rather than somewhere up the page. */
	.currency-input {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.currency-body {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		/* Comfortably past the 44px minimum target (WCAG 2.5.5) in both dimensions, since
		   the whole tile is the target. */
		min-height: 4.75rem;
		padding: var(--space-3) var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
		color: var(--color-text);
		text-align: center;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.currency-tile:hover .currency-body {
		border-color: var(--color-border-strong);
		background: var(--color-surface-hover);
	}

	.currency-tile:active .currency-body {
		transform: scale(0.98);
	}

	/* The app's own focus ring (app.css), moved onto the tile: the real input is clipped to
	   nothing, so its outline is clipped away with it. Sitting 2px outside the tile's border
	   is also what keeps it visible on the CHECKED tile, where an inset ring in the accent
	   colour would disappear into the accent border and fill it already has. */
	.currency-input:focus-visible + .currency-body {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.currency-input:checked + .currency-body {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.currency-symbol {
		font-family: var(--font-mono);
		font-size: var(--font-size-lg);
		line-height: 1;
		color: var(--color-text-faint);
	}

	.currency-input:checked + .currency-body .currency-symbol {
		color: inherit;
	}

	.currency-code {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		line-height: 1;
	}

	/* Wraps rather than truncating. On a phone three tiles across leaves about thirteen
	   characters, and "Norwegian k..." tells a traveller less than two short lines do. The
	   grid stretches every tile in a row to the tallest, so a wrapped name costs alignment
	   nothing. */
	.currency-name {
		max-width: 100%;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
		text-wrap: balance;
	}

	.currency-input:checked + .currency-body .currency-name {
		color: inherit;
	}

	/* The redundant, non-colour signal for the chosen tile. */
	.currency-check {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		width: 0.875rem;
		height: 0.875rem;
		opacity: 0;
		color: var(--color-accent);
	}

	.currency-input:checked + .currency-body .currency-check {
		opacity: 1;
	}

	.currency-note {
		margin: var(--space-4) 0 0;
		max-width: 68ch;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.currency-body {
			transition: none;
		}

		.currency-tile:active .currency-body {
			transform: none;
		}
	}
</style>
