/**
 * Kiwi's own timestamp convention makes this adapter's timezone maths simpler than
 * Ryanair's (ryanair-timezone.ts): every departure/arrival comes as a *pair* of Unix
 * timestamps in seconds — `dTime`/`aTime`, the wall-clock reading at that airport encoded
 * as if it were itself UTC, and `dTimeUTC`/`aTimeUTC`, the real UTC instant for the same
 * moment (github.com/SScorp/Skypicker-apiary: "do not convert the time between time
 * zones"). Diffing the two gives the exact UTC offset with no `Intl`/timezone-database
 * lookup at all, unlike Ryanair, which only ever gets one wall-clock string and has to
 * derive the offset from an IANA zone name fetched separately.
 *
 * What Kiwi does NOT give this adapter, on any field the historical spec documents, is the
 * IANA zone name itself (domain's `LocalDateTime.timeZone`, e.g. "Europe/Vienna") — only
 * the numeric offset can be derived directly. `resolveTimeZone` below fills that gap with
 * a small table for the single-timezone European countries this app's brief actually
 * targets, falling back to a synthetic fixed-offset zone otherwise. See its own comment
 * for why that fallback is a real, documented limitation rather than a silent guess.
 */

import type { Duration, LocalDateTime } from '../../domain';

/** IATA country code to IANA zone, restricted to countries that use exactly one civil
 * time zone with the standard EU-wide DST rule — the set this app's own scope (European
 * stopover trips) actually needs, per docs/PROVIDERS.md and AGENTS.md's worked example.
 * Deliberately NOT exhaustive: a global table would need to handle countries spanning
 * several zones (the US, Russia, Brazil, Australia...), which needs more than a
 * country-code key and is out of scope for this issue. */
const SINGLE_ZONE_COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
	ES: 'Europe/Madrid',
	PT: 'Europe/Lisbon',
	FR: 'Europe/Paris',
	DE: 'Europe/Berlin',
	IT: 'Europe/Rome',
	GB: 'Europe/London',
	IE: 'Europe/Dublin',
	NL: 'Europe/Amsterdam',
	BE: 'Europe/Brussels',
	AT: 'Europe/Vienna',
	CH: 'Europe/Zurich',
	PL: 'Europe/Warsaw',
	CZ: 'Europe/Prague',
	SK: 'Europe/Bratislava',
	HU: 'Europe/Budapest',
	RO: 'Europe/Bucharest',
	BG: 'Europe/Sofia',
	GR: 'Europe/Athens',
	HR: 'Europe/Zagreb',
	SI: 'Europe/Ljubljana',
	DK: 'Europe/Copenhagen',
	SE: 'Europe/Stockholm',
	NO: 'Europe/Oslo',
	FI: 'Europe/Helsinki',
	EE: 'Europe/Tallinn',
	LV: 'Europe/Riga',
	LT: 'Europe/Vilnius',
	IS: 'Atlantic/Reykjavik',
	MT: 'Europe/Malta',
	LU: 'Europe/Luxembourg',
	CY: 'Asia/Nicosia',
	RS: 'Europe/Belgrade',
	BA: 'Europe/Sarajevo',
	MK: 'Europe/Skopje',
	AL: 'Europe/Tirane',
	ME: 'Europe/Podgorica',
	MD: 'Europe/Chisinau',
	TR: 'Europe/Istanbul'
};

/** Parses one of Kiwi's local-clock-as-Unix-seconds fields into an ISO local date-time
 * string with no zone suffix, e.g. "2026-10-13T09:10:00". */
function toIsoLocalString(fakeUtcSeconds: number): string {
	return new Date(fakeUtcSeconds * 1000).toISOString().slice(0, 19);
}

/**
 * The one honest limitation in this file: when `countryIsoCode` isn't in
 * `SINGLE_ZONE_COUNTRY_TIME_ZONES` (a non-European airport, or a country whose civil time
 * needs more than a country code to resolve), there is no IANA zone name to fall back to
 * — Kiwi's response never carries one. Rather than guess a real zone name and risk it
 * being wrong across a DST boundary, this returns a synthetic fixed-offset identifier
 * (`Etc/GMT-2` for UTC+2, note the sign flip — that's the POSIX/IANA convention) built
 * from the offset this leg actually has right now.
 *
 * `utcOffsetMinutes` on the returned `LocalDateTime` is always numerically correct either
 * way, because it comes straight from Kiwi's own dTime/dTimeUTC pair, not from this
 * lookup. What a fixed-offset fallback zone gets WRONG is a downstream calculation that
 * needs this airport's offset on a *different* date than the one being mapped right now —
 * exactly the case a multi-day stopover creates if a DST transition falls inside it. That
 * risk is real only for airports outside the table above, i.e. outside this app's current
 * European scope; it is flagged here rather than hidden because AGENTS.md asks for that
 * ("say what you do not know rather than guessing"), not because it has been fixed.
 */
function resolveTimeZone(countryIsoCode: string | undefined, utcOffsetMinutes: number): string {
	const known = countryIsoCode ? SINGLE_ZONE_COUNTRY_TIME_ZONES[countryIsoCode.toUpperCase()] : undefined;
	if (known) return known;
	if (utcOffsetMinutes % 60 === 0) {
		const offsetHours = utcOffsetMinutes / 60;
		return offsetHours === 0 ? 'Etc/GMT' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
	}
	// A genuine half/quarter-hour offset with no country match: there is no fixed-offset
	// IANA zone for that either, so this is the one case with no honest zone identifier
	// available at all. UTC is wrong in the same documented way as the Etc/GMT fallback,
	// not additionally wrong.
	return 'UTC';
}

/** Builds a domain `LocalDateTime` from one of Kiwi's local/UTC Unix-second pairs. */
export function toLocalDateTime(
	fakeUtcSeconds: number,
	trueUtcSeconds: number,
	countryIsoCode: string | undefined
): LocalDateTime {
	const utcOffsetMinutes = Math.round((fakeUtcSeconds - trueUtcSeconds) / 60);
	return {
		local: toIsoLocalString(fakeUtcSeconds),
		timeZone: resolveTimeZone(countryIsoCode, utcOffsetMinutes),
		utcOffsetMinutes
	};
}

/** The real elapsed time between two legs of a Kiwi segment, from the true-UTC timestamp
 * pair — never from the local/fake-UTC fields, which live in two different airports'
 * clocks and cannot be subtracted directly (AGENTS.md "Timezones"). */
export function computeFlightDuration(departureUtcSeconds: number, arrivalUtcSeconds: number): Duration {
	return Math.round((arrivalUtcSeconds - departureUtcSeconds) / 60) as Duration;
}
