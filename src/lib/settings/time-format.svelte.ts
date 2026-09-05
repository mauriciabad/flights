/**
 * Whether a clock on screen reads `9:05am` or `09:05`, and where that choice is kept.
 *
 * Issue #229, the owner: "i want am/pm not 24h format, this can be a setting (separate
 * issue)". So am/pm is what the app does, and 24-hour is what a traveller can ask for.
 *
 * ## Why a module of its own rather than a field on `KeyStore`
 *
 * #229 says to copy the currency selector's pattern, and this copies its shape exactly: a
 * rune singleton over one plain, validated, namespaced `localStorage` entry, read through
 * a guard that survives Safari private mode and a prerender with no `window`. What it does
 * not copy is the currency's address. `KeyStore` holds provider credentials and rides in
 * the export/import JSON a traveller carries between browsers, and search currency earns a
 * seat there because it changes what the providers are asked for. This changes nothing but
 * the glyphs, so putting it in the credential file would ship a display preference inside
 * something a person pastes into a support thread.
 *
 * ## Why the chosen value and the effective value are separate getters
 *
 * `chosen` is `undefined` until someone picks, exactly as `keyStore.currency` is, so a
 * control can tell "never touched" from "deliberately set to the default". `current` is
 * what a formatter wants and never has to think about.
 */

/** The two ways this app writes a clock. `12h` is `9:05am`; `24h` is `09:05`. */
export type TimeFormat = '12h' | '24h';

/**
 * am/pm, per #229. The owner asked for it by name, and the 24-hour setting exists for
 * everyone who reads a departure board instead.
 */
export const DEFAULT_TIME_FORMAT: TimeFormat = '12h';

/**
 * Its own entry, and namespaced and versioned like `flights.searchCurrency.v1` beside it,
 * for the reason `keys/storage.ts` gives: a browser that refuses one write still leaves the
 * others readable, and a plain string needs no parse that could throw.
 */
const TIME_FORMAT_STORAGE_KEY = 'flights.timeFormat.v1';

function isTimeFormat(value: unknown): value is TimeFormat {
	return value === '12h' || value === '24h';
}

/**
 * `localStorage` throws in Safari private mode, in some embedded webviews and over quota,
 * and does not exist at all while the shell is prerendered. Every access here answers
 * "nothing chosen" rather than raising, the same contract `keys/storage.ts` keeps.
 */
export function loadTimeFormatFromStorage(): TimeFormat | undefined {
	try {
		if (typeof localStorage === 'undefined') return undefined;
		const raw = localStorage.getItem(TIME_FORMAT_STORAGE_KEY);
		return isTimeFormat(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

export function saveTimeFormatToStorage(format: TimeFormat): boolean {
	try {
		if (typeof localStorage === 'undefined') return false;
		localStorage.setItem(TIME_FORMAT_STORAGE_KEY, format);
		return true;
	} catch {
		return false;
	}
}

export function clearTimeFormatFromStorage(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(TIME_FORMAT_STORAGE_KEY);
	} catch {
		// Nothing to roll back to, and nothing the caller could do about it either.
	}
}

/**
 * A store rather than component state because every clock in the app reads it and no
 * component owns them all: `format.ts` resolves it inside `formatClockTime`, so a screen
 * that never heard of this setting still honours it. AGENTS.md asks for a reason in a
 * comment whenever state outlives a component tree, and this is that reason.
 */
export class TimeFormatPreference {
	#chosen = $state<TimeFormat | undefined>(undefined);

	constructor() {
		this.#chosen = loadTimeFormatFromStorage();
	}

	/** What the traveller picked, or `undefined` if they never have. */
	get chosen(): TimeFormat | undefined {
		return this.#chosen;
	}

	/** What a clock should actually print. */
	get current(): TimeFormat {
		return this.#chosen ?? DEFAULT_TIME_FORMAT;
	}

	set(format: TimeFormat): void {
		if (!isTimeFormat(format) || format === this.#chosen) return;
		this.#chosen = format;
		saveTimeFormatToStorage(format);
	}

	/** Back to "never chosen", which reads as am/pm again. For a settings reset and for
	 * tests, which would otherwise leak one case's choice into the next. */
	reset(): void {
		this.#chosen = undefined;
		clearTimeFormatFromStorage();
	}
}

export const timeFormat = new TimeFormatPreference();
