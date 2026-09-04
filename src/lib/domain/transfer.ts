import type { Coordinates } from './coordinates';
import type { LocalDateTime } from './datetime';
import type { Duration } from './duration';
import type { Money } from './money';

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
	 * quote it. */
	price?: Money;
	legs: TransferLeg[];
	/**
	 * Present only when mode is 'transit'. `following` can be an empty array — that is
	 * the "missed the last bus" case, and it is data to show, not an error to throw.
	 */
	transitSchedule?: {
		intended: LocalDateTime;
		following: LocalDateTime[];
	};
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
