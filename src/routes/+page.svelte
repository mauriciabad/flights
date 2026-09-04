<script lang="ts">
	const legs = [
		{ label: 'Barcelona', sub: 'BCN', kind: 'origin' },
		{ label: '2h 05m', sub: 'Vueling VY8472', kind: 'flight' },
		{ label: 'Vienna', sub: '3 nights, hostel from €19', kind: 'stay' },
		{ label: '1h 50m', sub: 'Wizz W64322', kind: 'flight' },
		{ label: 'Bucharest', sub: 'OTP', kind: 'destination' }
	] as const;
</script>

<svelte:head>
	<title>Layover — flights with a free trip in between</title>
	<meta
		name="description"
		content="Find flights to places with no direct route by turning the connection into a trip of its own."
	/>
</svelte:head>

<main>
	<header>
		<p class="eyebrow">flights.mauri.app</p>
		<h1>The layover <em>is</em> the trip.</h1>
		<p class="lede">
			Getting somewhere with no direct route usually means four dead hours in a terminal. Stay three
			days instead and it often costs less than flying direct, and you get a second city out of it.
		</p>
	</header>

	<section class="demo" aria-label="Example itinerary">
		<ol>
			{#each legs as leg (leg.sub)}
				<li class={leg.kind}>
					<span class="dot" aria-hidden="true"></span>
					<span class="label">{leg.label}</span>
					<span class="sub">{leg.sub}</span>
				</li>
			{/each}
		</ol>
		<p class="caption">One search. Both flights, a bed, and every transfer between them.</p>
	</section>

	<section class="status">
		<h2>Being built right now</h2>
		<p>
			This is under active construction by a swarm of agents. The search itself is not wired up yet.
			Progress is tracked as issues, and the whole thing is open source.
		</p>
		<p class="links">
			<a href="https://github.com/mauriciabad/flights">Repository</a>
			<a href="https://github.com/mauriciabad/flights/issues">Open issues</a>
		</p>
	</section>

	<footer>
		<p>
			Transit data by <a href="https://transitous.org">Transitous</a>, airports by
			<a href="https://ourairports.com">OurAirports</a>. Your API keys stay in your browser.
		</p>
	</footer>
</main>

<style>
	:root {
		--ink: #f2f5ff;
		--ink-dim: #9aa4c4;
		--bg: #0b1020;
		--bg-raised: #141b33;
		--line: #26304f;
		--accent: #4cc2ff;
		--accent-warm: #ffb454;
	}

	:global(body) {
		margin: 0;
		background:
			radial-gradient(120% 80% at 50% 0%, #17204070 0%, transparent 60%),
			var(--bg);
		color: var(--ink);
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
		-webkit-font-smoothing: antialiased;
	}

	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: clamp(2rem, 8vw, 5rem) 1.25rem 3rem;
	}

	.eyebrow {
		margin: 0 0 1.5rem;
		font-family: ui-monospace, 'SF Mono', monospace;
		font-size: 0.75rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent);
	}

	h1 {
		margin: 0 0 1rem;
		font-size: clamp(2.25rem, 8vw, 3.75rem);
		line-height: 1.04;
		letter-spacing: -0.03em;
		font-weight: 700;
	}

	h1 em {
		font-style: normal;
		color: var(--accent-warm);
	}

	.lede {
		margin: 0;
		font-size: clamp(1rem, 2.4vw, 1.2rem);
		line-height: 1.6;
		color: var(--ink-dim);
		max-width: 34rem;
	}

	.demo {
		margin: clamp(2.5rem, 8vw, 4rem) 0;
		padding: 1.5rem 1.25rem 1.25rem;
		background: var(--bg-raised);
		border: 1px solid var(--line);
		border-radius: 14px;
	}

	ol {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0;
	}

	li {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 0.9rem;
		padding: 0 0 1.4rem 0;
	}

	li:last-child {
		padding-bottom: 0;
	}

	/* The rail joins each stop to the next. The last item has no successor. */
	li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: 5px;
		top: 1.1rem;
		bottom: -0.1rem;
		width: 2px;
		background: var(--line);
	}

	.dot {
		grid-row: span 2;
		width: 12px;
		height: 12px;
		margin-top: 0.3rem;
		border-radius: 50%;
		border: 2px solid var(--accent);
		background: var(--bg-raised);
		box-sizing: border-box;
	}

	li.stay .dot {
		border-color: var(--accent-warm);
		background: var(--accent-warm);
	}

	li.flight .dot {
		border-color: var(--line);
		width: 8px;
		height: 8px;
		margin-left: 2px;
		margin-top: 0.45rem;
	}

	.label {
		font-weight: 600;
		font-size: 1rem;
	}

	li.flight .label {
		font-weight: 400;
		color: var(--ink-dim);
		font-size: 0.9rem;
	}

	li.stay .label {
		color: var(--accent-warm);
	}

	.sub {
		grid-column: 2;
		font-size: 0.8rem;
		color: var(--ink-dim);
		font-family: ui-monospace, 'SF Mono', monospace;
	}

	.caption {
		margin: 0.5rem 0 0;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
		font-size: 0.85rem;
		color: var(--ink-dim);
	}

	.status h2 {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		letter-spacing: -0.01em;
	}

	.status p {
		margin: 0 0 0.75rem;
		color: var(--ink-dim);
		line-height: 1.6;
		font-size: 0.95rem;
	}

	.links {
		display: flex;
		gap: 1.25rem;
		flex-wrap: wrap;
	}

	a {
		color: var(--accent);
	}

	footer {
		margin-top: clamp(2.5rem, 8vw, 4rem);
		padding-top: 1.25rem;
		border-top: 1px solid var(--line);
		font-size: 0.8rem;
		color: var(--ink-dim);
		line-height: 1.6;
	}

	footer p {
		margin: 0;
	}

	@media (prefers-color-scheme: light) {
		:root:not([data-theme='dark']) {
			--ink: #131829;
			--ink-dim: #5a6484;
			--bg: #f6f7fb;
			--bg-raised: #ffffff;
			--line: #dfe3ef;
			--accent: #0a6ebd;
			--accent-warm: #a35a00;
		}
	}
</style>
