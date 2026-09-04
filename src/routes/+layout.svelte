<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	// Served from `static/icons/`, not `$lib` — those files ship as-is to
	// the build root, so the base path has to be prefixed by hand here.
	const iconSrc = `${base}/icons/icon.svg`;

	interface NavItem {
		id: 'search' | 'results' | 'comparator' | 'settings';
		label: string;
		href: string;
	}

	// Every route below is owned by a different issue (#16, #23, #25, #29).
	// This shell only needs to know they exist and where they live. Search
	// lives at "/" — it's the landing screen — so #16 belongs in
	// src/routes/+page.svelte, not a new src/routes/search/.
	const navItems: NavItem[] = [
		{ id: 'search', label: 'Search', href: '/' },
		{ id: 'results', label: 'Results', href: '/results/' },
		{ id: 'comparator', label: 'Compare', href: '/comparator/' },
		{ id: 'settings', label: 'Settings', href: '/settings/' }
	];

	function fullHref(href: string): string {
		return `${base}${href}`;
	}

	function isActive(href: string): boolean {
		return page.url.pathname === fullHref(href);
	}
</script>

<svelte:head>
	<link rel="icon" href={iconSrc} />
	<!-- Fallback only. A page announced by screen readers on navigation
	     needs its own descriptive <title>; route owners should set one. -->
	<title>Layover</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="app-shell">
	<header class="app-header">
		<a class="app-brand" href={fullHref('/')} aria-label="Layover, home">
			<img src={iconSrc} alt="" width="24" height="24" />
			<span>Layover</span>
		</a>
	</header>

	<nav class="app-nav" aria-label="Primary">
		<ul>
			{#each navItems as item (item.id)}
				<li>
					<a href={fullHref(item.href)} aria-current={isActive(item.href) ? 'page' : undefined}>
						<span class="app-nav-icon" aria-hidden="true">
							{#if item.id === 'search'}
								<svg viewBox="0 0 24 24" fill="none">
									<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
									<line
										x1="21"
										y1="21"
										x2="16.65"
										y2="16.65"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
									/>
								</svg>
							{:else if item.id === 'results'}
								<svg viewBox="0 0 24 24" fill="none">
									<line x1="8" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="8" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="8" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<circle cx="3.5" cy="6" r="1.5" fill="currentColor" />
									<circle cx="3.5" cy="12" r="1.5" fill="currentColor" />
									<circle cx="3.5" cy="18" r="1.5" fill="currentColor" />
								</svg>
							{:else if item.id === 'comparator'}
								<svg viewBox="0 0 24 24" fill="none">
									<rect x="3" y="4" width="5" height="16" rx="1" stroke="currentColor" stroke-width="2" />
									<rect x="9.5" y="4" width="5" height="16" rx="1" stroke="currentColor" stroke-width="2" />
									<rect x="16" y="4" width="5" height="16" rx="1" stroke="currentColor" stroke-width="2" />
								</svg>
							{:else}
								<svg viewBox="0 0 24 24" fill="none">
									<line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
									<line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
								</svg>
							{/if}
						</span>
						<span class="app-nav-label">{item.label}</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<main id="main-content" class="app-content" tabindex="-1">
		{@render children()}
	</main>
</div>

<style>
	.skip-link {
		position: fixed;
		top: -3rem;
		left: var(--space-3);
		z-index: var(--z-skip-link);
		padding: var(--space-2) var(--space-4);
		background: var(--color-accent);
		color: var(--color-accent-text);
		border-radius: var(--radius-md);
		text-decoration: none;
		font-weight: var(--font-weight-semibold);
		transition: top var(--transition-fast);
	}

	.skip-link:focus-visible {
		top: var(--space-3);
	}

	/* Mobile-first shell: header on top, content in the middle scrolling
	   on its own, a thumb-reachable tab bar pinned to the bottom. Grid
	   areas (not DOM order) move the nav from "own row at the bottom" to
	   "beside the brand" at the desktop breakpoint, so there is exactly
	   one <nav>, not a mobile copy and a desktop copy. */
	.app-shell {
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: auto 1fr auto;
		grid-template-areas:
			'header'
			'main'
			'nav';
		min-height: 100dvh;
		background: var(--color-bg);
	}

	.app-header {
		grid-area: header;
		display: flex;
		align-items: center;
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg-elevated);
		border-bottom: 1px solid var(--color-border);
	}

	.app-brand {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--font-weight-bold);
		font-size: var(--font-size-xl);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
		text-decoration: none;
	}

	.app-content {
		grid-area: main;
		overflow-y: auto;
		overflow-x: hidden;
		min-width: 0;
		padding: var(--space-4);
	}

	.app-content:focus-visible {
		outline: none;
	}

	.app-nav {
		grid-area: nav;
		background: var(--color-bg-elevated);
		border-top: 1px solid var(--color-border);
		/* Clears the home-bar area on notched phones without adding
		   visible space on devices that don't have one. */
		padding-bottom: env(safe-area-inset-bottom);
	}

	.app-nav ul {
		display: flex;
	}

	.app-nav li {
		flex: 1;
		min-width: 0;
	}

	.app-nav a {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		/* >=44px tap target, per WCAG 2.5.5, for someone using this
		   one-handed. */
		min-height: 3.5rem;
		padding: var(--space-2) var(--space-1);
		color: var(--color-text-muted);
		text-decoration: none;
		font-size: var(--font-size-xs);
		font-weight: var(--font-weight-medium);
		transition: color var(--transition-fast);
	}

	.app-nav a:active {
		transform: scale(0.96);
	}

	/* The current tab reads as a lit gate on a departure board: a filled
	   pill behind the icon, not just a colour swap, so it is legible at a
	   glance and not only by hue (contrast this deliberately survives
	   both themes since it is background + colour together, never colour
	   alone). */
	.app-nav-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-full);
		transition: background-color var(--transition-fast);
	}

	.app-nav-icon svg {
		width: 1.25rem;
		height: 1.25rem;
	}

	.app-nav a:hover {
		color: var(--color-text);
	}

	.app-nav a[aria-current='page'] {
		color: var(--color-accent);
	}

	.app-nav a[aria-current='page'] .app-nav-icon {
		background: var(--color-accent-muted);
	}

	.app-nav a[aria-current='page']:hover {
		color: var(--color-accent-hover);
	}

	@media (min-width: 48rem) {
		.app-shell {
			grid-template-columns: auto 1fr;
			grid-template-rows: auto 1fr;
			grid-template-areas:
				'header nav'
				'main main';
		}

		.app-nav {
			justify-self: end;
			align-self: stretch;
			background: var(--color-bg-elevated);
			border-top: none;
			border-bottom: 1px solid var(--color-border);
			padding-bottom: 0;
		}

		.app-nav ul {
			height: 100%;
		}

		.app-nav li {
			flex: none;
		}

		.app-nav a {
			flex-direction: row;
			min-height: auto;
			height: 100%;
			padding-inline: var(--space-4);
			font-size: var(--font-size-sm);
		}

		.app-content {
			padding: var(--space-6);
		}
	}

	/* Search, results, comparator and settings all wrap their own content
	   at --layout-max-width; the shell itself stays full-bleed so a
	   full-width control (like the comparator's own horizontal scroller)
	   still has the whole viewport to work with. */
</style>
