/**
 * Which glyph stands for a step of a journey, and how far down the transit tree it goes.
 *
 * Issue #322: a flight segment carries its airline's logo, so at a glance you know who is
 * flying you; a transport segment carried nothing, so a bus, a train, a taxi and a walk all
 * looked alike until you read the words. The icon is the fix, and the only interesting part
 * of it is how specific it is allowed to be.
 *
 * ## How far down, and why it stops there
 *
 * `TransferMode` has four values and three of them are already the answer: a walk is a
 * walk, a taxi is a taxi, a drive is a drive. `transit` is the one that hides things.
 * Underneath it, `TransferLeg.vehicle` carries what Transitous called each ride — "Bus",
 * "Metro", "Train", "Ferry" and the rest of `TRANSIT_MODE_LABELS` — and the issue's own
 * warning is that "a generic transit icon over a leg the app knows is a train is exactly
 * the small dishonesty this codebase keeps catching."
 *
 * So this goes exactly one level below `transit`, to the vehicle FAMILY, and stops there
 * for two reasons that pull the same way.
 *
 * The first is the icon set. Tabler draws a bus, a train and a ferry. It has no tram, no
 * metro, no cable car, no gondola and no funicular, and drawing a train for a gondola would
 * be the dishonesty this is trying to avoid, one step further down.
 *
 * The second is that a transfer is usually several rides. "Bus, then metro" has no single
 * true vehicle, and `itinerary-timeline-format.ts` already refuses to name the vehicles in
 * that case and counts them instead. This refuses in the same place, for the same reason: a
 * family is claimed only when every ride in the transfer agrees on one. Anything else — a
 * mixture, a ride the provider did not name, a family Tabler cannot draw — falls back to
 * the plain transit mark.
 *
 * That mark is a bus, which is a claim of a kind, and it is the claim airport signage
 * already makes: the bus seen head-on is what "public transport" means on a sign, and it is
 * what `ModeIcon` has drawn for `transit` since issue #119. A traveller who wants the exact
 * vehicles has them in words, on the same row, every time.
 */

import type { Transfer, TransferLeg } from '$lib/domain';

/**
 * What a `ModeIcon` may depict. A superset of `TransferMode`, so a caller holding a
 * `Transfer` can pass `transfer.mode` straight in, plus the three timeline step kinds and
 * the two transit families specific enough to earn their own glyph.
 */
export type ModeIconKind =
	| 'walk'
	| 'transit'
	| 'transit-rail'
	| 'transit-ferry'
	| 'taxi'
	| 'drive'
	| 'flight'
	| 'wait'
	| 'stopover';

/**
 * Every vehicle word this app can receive, and the glyph family it belongs to.
 *
 * Keyed on the exact strings `transitous-mapper.ts`'s `TRANSIT_MODE_LABELS` produces, which
 * is the only thing that ever writes `TransferLeg.vehicle`. Those two tables have to agree,
 * so `mode-icon.test.ts` holds them to it: a label added there without a decision here
 * fails that test rather than quietly rendering a bus.
 *
 * Absent on purpose, not by omission: "Cable car", "Gondola" and "Funicular" have no icon
 * in Tabler, and "Transit" is the mapper's own fallback for a mode it did not recognise,
 * which is the opposite of knowing what the vehicle is. All four take the plain transit
 * mark.
 */
export const VEHICLE_FAMILY: Readonly<Record<string, 'road' | 'rail' | 'water'>> = {
	Bus: 'road',
	Coach: 'road',
	Metro: 'rail',
	Tram: 'rail',
	Train: 'rail',
	'Night train': 'rail',
	Ferry: 'water'
};

const FAMILY_KIND = {
	road: 'transit',
	rail: 'transit-rail',
	water: 'transit-ferry'
} as const satisfies Record<string, ModeIconKind>;

/**
 * The glyph for one leg. A leg is the bottom of the tree — one ride, one vehicle — so this
 * is as specific as the app ever gets, and the transport picker's step list is the one
 * place that can use it: it prints "Bus 46 to Aeroport BCN (TMB)" a line at a time.
 *
 * `transit` back means the same three silences every time: the provider named no vehicle,
 * it named one this set has no icon for, or the leg is not transit at all and its own mode
 * is the answer.
 */
export function legIconKind(leg: TransferLeg): ModeIconKind {
	if (leg.mode !== 'transit') return leg.mode;
	const family = leg.vehicle ? VEHICLE_FAMILY[leg.vehicle] : undefined;
	return family ? FAMILY_KIND[family] : 'transit';
}

/**
 * The glyph for one whole ground transfer, as specific as the app can honestly be about it.
 *
 * Not a `$derived` in three components, because the same answer belongs on the trip strip,
 * in the timeline rail and on a picker row, and three copies of this rule is how they come
 * to disagree about the same journey.
 *
 * The walking legs are dropped first: a transit transfer almost always opens and closes
 * with the walk to and from a stop, and neither says anything about the vehicle in the
 * middle. What is left has to agree, or the transfer keeps the plain transit mark.
 */
export function transferIconKind(transfer: Transfer): ModeIconKind {
	if (transfer.mode !== 'transit') return transfer.mode;

	const kinds = transfer.legs.filter((leg) => leg.mode !== 'walk').map(legIconKind);
	const [first] = kinds;
	// No rides at all is a transit answer with nothing under it — a `Transfer` cached before
	// its legs were populated. `some` then catches the mixture, since a second family never
	// equals the first, and a leg that came back generic drags a specific one back to
	// generic for exactly that reason.
	if (first === undefined || kinds.some((kind) => kind !== first)) return 'transit';
	return first;
}
