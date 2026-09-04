/**
 * Pure display formatting for Comparator.svelte (issue #25), kept out of the component
 * file for the same reason itinerary-timeline-format.ts is: testable without mounting
 * Svelte. See that file for the shared duration/money/clock formatters this one builds on.
 */

/**
 * "2 minutes ago", "yesterday": how stale a provider's price is, per the results-list
 * issue's own requirement (#23: "Show provenance... when it was fetched") reused here for
 * the comparator's top card. `now` is a parameter, not `Date.now()` read internally, so a
 * test can pass a fixed instant instead of racing the clock.
 */
export function formatRelativeFetchTime(fetchedAt: string, now: number = Date.now()): string {
	const diffMinutes = Math.round((now - Date.parse(fetchedAt)) / 60_000);
	// Anything under a minute reads as "just now" rather than "in 0 minutes" or "0
	// minutes ago", which Intl.RelativeTimeFormat would otherwise produce for the exact
	// instant a fetch resolves.
	if (Math.abs(diffMinutes) < 1) return 'just now';

	const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
	if (Math.abs(diffMinutes) < 60) return rtf.format(-diffMinutes, 'minute');

	const diffHours = Math.round(diffMinutes / 60);
	if (Math.abs(diffHours) < 24) return rtf.format(-diffHours, 'hour');

	const diffDays = Math.round(diffHours / 24);
	return rtf.format(-diffDays, 'day');
}

/**
 * "skyscanner" -> "Skyscanner": a readable stand-in for a provider id. The real label
 * ("Skyscanner (RapidAPI)") lives on `ProviderBase.label` in the registry
 * (providers/registry.ts), which the comparator has no reason to depend on for a display
 * component that only ever receives a `ProviderSource.providerId` string. Capitalising the
 * id is an honest fallback, not a guess at the registry's own copy.
 */
export function providerDisplayName(providerId: string): string {
	if (providerId.length === 0) return providerId;
	return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * `value` as a fraction of `max`, clamped to [0, 1]. The one bit of arithmetic behind the
 * comparator's free-time bar (see Comparator.svelte's header comment on the
 * proportional-vs-order-based decision): rows stay ordered, not time-scaled, but this
 * still gives a magnitude a reader can see at a glance rather than only read as text.
 * Returns 0 for a non-positive `max` instead of dividing by zero or a negative number.
 */
export function relativeShare(value: number, max: number): number {
	if (max <= 0) return 0;
	return Math.min(Math.max(value / max, 0), 1);
}
