import type { Coordinates } from './coordinates';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { Money } from './money';
import type { TransitSchedule } from './transit-schedule';

/** Brief line 77: "walking, public transport time and driving time". */
export type TransferMode = 'walk' | 'transit' | 'taxi' | 'drive';

/**
 * The longest walk worth putting in front of a traveller, and the longest one worth
 * asking a router about.
 *
 * Issue #119, the owner's own words: **"'Walk 11h 42m' WTF dont even show this, walk is
 * not an option in this case."** He was right, and nothing had asked whether a walking
 * duration was plausible before ranking it, so an eleven-hour walk beat a taxi that took
 * forty minutes.
 *
 * 45 minutes, and the number is arguable, so here is the argument. OSRM's foot profile
 * runs about 4.5 km/h (measured directly, see `providers/transfers/osrm.ts`'s header), so
 * this is roughly 3.4 km. A walk somebody who has just dragged a suitcase off a flight
 * might still choose, and past which they will not. It also has to leave the short walks
 * alone, because a 12-minute walk genuinely beats waiting for a bus, and this cap does:
 * `TransportPicker` already treats a wait under 20 minutes as one you would have had
 * anyway, so a typical airport hop of "wait 20, ride 15" is 35 minutes end to end and any
 * walk that beats it survives with room to spare.
 *
 * A single named constant rather than a `SearchQuery` field, deliberately. The brief's
 * editable waiting time is a preference this app has no grounds to overrule. A twelve-hour
 * walk is not a preference, it is the router answering a question nobody asked, and the
 * leg degrades to "no transfer found", which every caller already handles.
 *
 * Driving and taxi are left uncapped on purpose. Issue #119 says the same reasoning
 * applies to an absurd driving duration and it does, but a road cap needs its own argument
 * about ferry links and routing artefacts, and it belongs with the rest of that issue.
 *
 * Issue #204 moved this here from `search/resources.ts`, where it could only ever filter a
 * router's answer. `providers/transfers/osrm.ts` now refuses to ASK for a walk this long,
 * and the two must agree about what "too long" is or the adapter would spend requests on
 * routes the filter throws away. `search/resources.ts` still re-exports it.
 */
export const MAX_PLAUSIBLE_WALK_MINUTES = 45 as Duration;

/**
 * What a transit transfer is allowed to cost that has nothing to do with how far it goes:
 * the walk to the stop, the walk off at the other end, and the changes in between.
 *
 * 90 minutes. Generous on purpose. This is one half of a rule that only has to catch the
 * absurd, and every minute of slack here is a real journey it cannot delete by mistake.
 */
export const TRANSIT_FIXED_ALLOWANCE_MINUTES = 90;

/**
 * The slowest a real transit journey can average, measured as straight-line kilometres per
 * hour rather than along the road, and the distance-dependent half of the same rule.
 *
 * Measured, not guessed. Barcelona airport to Plaça Catalunya is 12.6 km apart in a
 * straight line, and on 2026-09-05 Transitous answered it with six itineraries between 50
 * and 62 minutes, every one of them two or three buses with changes, about the slowest
 * shape a city transfer takes. That is 12.2 km/h at its worst. Rounding down to 10 keeps
 * the gate below anything observed, the same direction `providers/transfers/osrm.ts` errs
 * in with `FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR`: the bound must never reject a journey a
 * traveller would actually take.
 */
export const SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR = 10;

/**
 * The longest public-transport transfer worth putting in front of a traveller, for two
 * points this far apart in a straight line.
 *
 * Issue #220. Asked how to get from Birmingham airport to a Birmingham hostel 9.7 km away,
 * Transitous answered with a 21h 27m itinerary that flies to Sardinia, Rome, Cagliari and
 * Amsterdam and comes back by train and coach through Den Haag and London Victoria. The
 * app printed it as "Public transport" and folded its duration into the door-to-door
 * figure `docs/ACCEPTANCE.md` calls the number this product is judged on. Nothing compared
 * the answer against the distance, so nothing could tell that journey from a bus.
 *
 * Expressed against straight-line distance rather than as a flat cap, because a legitimate
 * transfer is 90 minutes across a big city and 10 minutes across a small one, and one
 * number cannot be right for both. #196's `MAX_PLAUSIBLE_WALK_MINUTES` could be flat: a
 * walk is a walk at any distance. A bus is not.
 *
 * What it allows, at the distances this app actually asks about:
 *
 * | straight line | bound | measured reality |
 * | --- | --- | --- |
 * | 9.7 km (BHX to the hostel in #220) | 2h 28m | the rejected answer was 21h 27m |
 * | 12.6 km (BCN to Plaça Catalunya) | 2h 46m | 50 to 62 minutes, six real itineraries |
 * | 48.9 km (Stansted to central London) | 6h 23m | the Stansted Express is about an hour |
 *
 * So it is loose, and loose is the point: it is a lower bound on absurdity, not an opinion
 * about which bus to take. `pickBestTransfer` still picks the quickest option among
 * whatever survives, so a slow-but-real route loses on its merits rather than being
 * deleted here.
 *
 * Driving and taxi stay uncapped, same as they are for the walk rule and for the same
 * reason: a road cap needs its own argument about ferry links and routing artefacts.
 */
export function maxPlausibleTransitMinutes(straightLineKm: number): Duration {
	const travel = (Math.max(0, straightLineKm) / SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR) * 60;
	return (TRANSIT_FIXED_ALLOWANCE_MINUTES + travel) as Duration;
}

export interface TransferLeg {
	mode: TransferMode;
	/** e.g. "Bus 100 to City Airport Station" — not always available from a provider. */
	description?: string;
	/**
	 * What kind of vehicle this leg rides, spelled for a traveller: "Bus", "Metro",
	 * "Train", "Coach", "Ferry". Absent on a walk, and absent whenever a provider did not
	 * say (issue #220 added it; a `Transfer` cached before that has no `vehicle` on any
	 * leg, so every reader needs a fallback).
	 *
	 * Separate from `description` rather than parsed back out of it. The description is
	 * one sentence built for a person, "Bus 46 to Aeroport BCN (TMB)", and a summary line
	 * that needs only the word "Bus" would otherwise have to take it apart by string
	 * surgery, which breaks the first time an operator's name contains a comma.
	 */
	vehicle?: string;
	departure?: LocalDateTime;
	arrival?: LocalDateTime;
	duration: Duration;
}

/**
 * Issue #1: "Transfer — mode, duration, price, legs, and for transit, the actual
 * departure times plus the following ones. Missing the last bus is a first-class outcome,
 * not an error."
 * Brief line 61 and line 84: whether transit is available at all, and the next departures
 * if the itinerary's intended one is missed, both need to render as an ordinary result.
 */
export interface Transfer {
	mode: TransferMode;
	duration: Duration;
	/** Walking has no price; other modes may still lack one if the provider doesn't
	 * quote it. Those two cases mean opposite things and `costIsUnknown` below is what
	 * separates them. An absent price on a walk is the fact that walking is free, and an
	 * absent price on a taxi is a number nobody measured. */
	price?: Money;
	legs: TransferLeg[];
	/**
	 * Present only when mode is 'transit'. `following` can be an empty array — that is
	 * the "missed the last bus" case, and it is data to show, not an error to throw.
	 *
	 * Issue #135: the shape moved to `transit-schedule.ts` when it gained `plannedFor`.
	 * A transit transfer with no schedule at all is a lookup that was never planned for a
	 * real journey moment, which is the one thing this app must never render as a timetable.
	 */
	transitSchedule?: TransitSchedule;
	/**
	 * Issue #118: the actual road/path this transfer follows, when a provider has one to
	 * give. OSRM's `route` service returns this alongside the duration it was already
	 * being asked for (`providers/transfers/osrm.ts`), so populating it costs a query
	 * parameter on a request already being made, never an extra one. `undefined` means
	 * no real shape is known — a `transit` leg (Transitous returns a schedule, not a
	 * geometry) or a route OSRM couldn't find — and a consumer (the itinerary map) must
	 * fall back to a straight line between the two endpoints, drawn so it visibly reads
	 * as a schematic hop rather than a real road.
	 */
	path?: Coordinates[];
}

/**
 * Whether this leg costs a number nobody has given us. Issue #204.
 *
 * An absent `Transfer.price` means two opposite things depending on the mode, and every
 * total in this app used to read both of them as zero. Walking really is free, so an
 * absent price there is a fact, and a total that omits it is complete. Every other mode
 * charges a fare, and no `TransferProvider` in this codebase quotes one (OSRM refuses to
 * on purpose, see its own header, and Transitous returns a timetable, not a ticket
 * price), so an absent price there is ignorance, and a total that omits it is a floor
 * being printed as though it were the answer.
 *
 * AGENTS.md, "When the data is missing": "say what you do not know rather than guessing."
 * This is the predicate that lets the rest of the app do that instead of quietly
 * substituting zero.
 */
export function costIsUnknown(transfer: Transfer): boolean {
	return transfer.mode !== 'walk' && transfer.price === undefined;
}
