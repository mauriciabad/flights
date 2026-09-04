<script lang="ts">
	/**
	 * Issue #130: what a finished search with no itineraries shows.
	 *
	 * The screen this replaces said "None of the free providers above found a workable
	 * connection for this search. Widen the search above, or try a different destination."
	 * On BVC to PFO that was a conclusion nobody observed: Ryanair had answered twice with a
	 * 404, meaning those airports are not on its network at all, and neither a wider date
	 * range nor a different destination addresses that. Every line rendered here comes from
	 * `results/no-results.ts`, which derives it from the search's own recorded provider
	 * answers.
	 *
	 * The look is the departure board the rest of this app is built around (`app.css`'s own
	 * "a departure board at night"), used here for its literal meaning: a board with no
	 * departures on it, one row per source that was asked, each carrying what that source
	 * actually said. A generic centred `EmptyState` was the previous treatment and it had
	 * nowhere to put per-source evidence, which is the whole point of this screen.
	 */
	import { Button } from '$lib/components';
	import { fixSentence } from '$lib/results/no-results';
	import type { NamedAirport, NoResultsExplanation } from '$lib/results/no-results';

	interface Props {
		explanation: NoResultsExplanation;
		origin: NamedAirport;
		destination: NamedAirport;
	}

	let { explanation, origin, destination }: Props = $props();

	/** Short enough to sit on a flap without wrapping, and still the real verdict. */
	const FLAP_TEXT = {
		answered: 'answered',
		'nothing-found': 'nothing found',
		failed: 'failed',
		'not-asked': 'not asked'
	} as const;
</script>

<section class="board" role="status" aria-label="Why this search found nothing">
	<header class="board-head">
		<p class="board-route">
			<span class="board-code">{origin.code}</span>
			<span class="board-arrow" aria-hidden="true">→</span>
			<span class="board-code">{destination.code}</span>
		</p>
		<h2 class="board-title">{explanation.title}</h2>
		<p class="board-detail">{explanation.detail}</p>
	</header>

	{#if explanation.sources.length > 0}
		<ul class="board-rows">
			{#each explanation.sources as source (source.providerId)}
				<li class="board-row" data-answer={source.answer}>
					<span class="row-rail" aria-hidden="true"></span>
					<span class="row-source">{source.label}</span>
					<span class="row-flap">{FLAP_TEXT[source.answer]}</span>
					<span class="row-cost font-mono tabular-nums">
						{source.requestsUsed}
						<span class="row-cost-unit">{source.requestsUsed === 1 ? 'req' : 'reqs'}</span>
					</span>
					{#if source.rawError}
						<!-- AGENTS.md: "show the actual errors recieved, not invent our own." -->
						<p class="row-raw font-mono">{source.rawError}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if explanation.fix}
		<div class="board-fix">
			<p class="fix-copy">{fixSentence(explanation.fix, destination)}</p>
			<Button href={explanation.fix.href} size="sm">{explanation.fix.actionLabel}</Button>
		</div>
	{/if}
</section>

<style>
	.board {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		padding: var(--space-6) var(--space-5) var(--space-5);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		background: var(--color-bg-inset);
		box-shadow: var(--shadow-md);
		overflow: hidden;
	}

	/* The tear line of a ticket stub, above the list of what each source said and again
	   below it (`.board-fix`). Two of them, top and bottom, are what make the source list
	   read as the detachable half of a ticket rather than as a plain bordered box. */
	.board-head {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-bottom: var(--space-5);
		border-bottom: 1px dashed var(--color-border-strong);
	}

	/* Nothing to detach: a board with no sources and no fix is just the sentence. */
	.board-head:last-child {
		padding-bottom: 0;
		border-bottom: none;
	}

	.board-route {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-faint);
	}

	.board-code {
		color: var(--color-text-muted);
	}

	.board-arrow {
		color: var(--color-text-faint);
	}

	.board-title {
		font-size: var(--font-size-xl);
		line-height: var(--line-height-xl);
		color: var(--color-text);
	}

	.board-detail {
		max-width: 46ch;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	.board-rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.board-row {
		display: grid;
		grid-template-columns: 0.25rem 1fr auto;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		background: var(--color-surface);
		list-style: none;
	}

	/* One rail per row, coloured by what that source actually did. This is the only place a
	   colour carries meaning here, so the three states stay tellable apart at a glance
	   without relying on the words alone. */
	.row-rail {
		align-self: stretch;
		min-height: 1.5rem;
		border-radius: var(--radius-full);
		background: var(--color-text-faint);
	}

	.board-row[data-answer='answered'] .row-rail {
		background: var(--color-success);
	}

	.board-row[data-answer='nothing-found'] .row-rail {
		background: var(--color-info);
	}

	.board-row[data-answer='failed'] .row-rail {
		background: var(--color-warning);
	}

	.row-source {
		min-width: 0;
		font-size: var(--font-size-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}

	/* A split-flap character plate: inset, monospaced, with the seam across its middle that
	   every real departure board has. */
	.row-flap {
		position: relative;
		grid-column: 2;
		justify-self: start;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset);
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		text-transform: uppercase;
		letter-spacing: var(--tracking-wide);
		color: var(--color-text-muted);
	}

	.row-flap::after {
		content: '';
		position: absolute;
		inset: 50% 0 auto 0;
		height: 1px;
		background: var(--color-border);
	}

	.board-row[data-answer='nothing-found'] .row-flap {
		color: var(--color-info);
	}

	.board-row[data-answer='failed'] .row-flap {
		color: var(--color-warning);
	}

	.board-row[data-answer='answered'] .row-flap {
		color: var(--color-success);
	}

	.row-cost {
		grid-column: 3;
		grid-row: 1;
		align-self: center;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.row-cost-unit {
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	.row-raw {
		grid-column: 2 / -1;
		font-size: var(--font-size-xs);
		line-height: var(--line-height-xs);
		color: var(--color-text-muted);
		overflow-wrap: anywhere;
	}

	.board-fix {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
		padding-top: var(--space-4);
		border-top: 1px dashed var(--color-border-strong);
	}

	.fix-copy {
		max-width: 46ch;
		font-size: var(--font-size-sm);
		line-height: var(--line-height-sm);
		color: var(--color-text-muted);
	}

	@media (min-width: 40rem) {
		.board-row {
			grid-template-columns: 0.25rem minmax(0, 14rem) 1fr auto;
		}

		.row-flap {
			grid-column: 3;
		}

		.row-cost {
			grid-column: 4;
		}

		.row-raw {
			grid-column: 2 / -1;
		}

		.board-fix {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
			gap: var(--space-5);
		}
	}
</style>
