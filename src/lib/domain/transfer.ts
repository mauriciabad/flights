import type { Coordinates } from './coordinates';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { Money } from './money';
import type { TransitSchedule } from './transit-schedule';

/** Brief line 77: "walking, public transport time and driving time". */
export type TransferMode = 'walk' | 'transit' | 'taxi' | 'drive';

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
