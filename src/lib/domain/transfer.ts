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

export interface TransferLeg {
	mode: TransferMode;
	/** e.g. "Bus 100 to City Airport Station" — not always available from a provider. */
	description?: string;
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
