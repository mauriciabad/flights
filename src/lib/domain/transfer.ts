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
 * Driving and taxi have their own rule now, `maxPlausibleRoadMinutes` below, and it is a
 * different shape for a reason that rule states in full.
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
 * Driving and taxi have their own rule, `maxPlausibleRoadMinutes` below.
 */
export function maxPlausibleTransitMinutes(straightLineKm: number): Duration {
	const travel = (Math.max(0, straightLineKm) / SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR) * 60;
	return (TRANSIT_FIXED_ALLOWANCE_MINUTES + travel) as Duration;
}

/**
 * What a road transfer is allowed to cost that has nothing to do with how far it goes.
 *
 * 60 minutes, which is generous, and the reason is that at short range straight-line
 * distance stops carrying any information. Two points a kilometre apart can have a river,
 * a runway or a rail corridor between them, and the real road answer is then a 20 km
 * detour to the nearest crossing: a completely ordinary transfer whose crow-flight pace
 * reads as 2 km/h. An hour of slack is what stops the rule below mistaking that for the
 * thing it is hunting. It also gives this rule a property worth stating plainly, because a
 * reader can check it without doing any arithmetic: **it can never refuse a road transfer
 * of an hour or less.**
 */
export const ROAD_FIXED_ALLOWANCE_MINUTES = 60;

/**
 * The slowest a real road transfer can average, measured as straight-line kilometres per
 * hour, and the distance-dependent half of the road rule.
 *
 * 7.5 km/h, which is barely above a walk, and that is the whole statement: a vehicle that
 * cannot beat a walker across the ground is not describing transport.
 * `FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR` in `providers/transfers/osrm.ts` puts the fastest
 * any pedestrian router could credibly claim at 6 km/h, and this floor sits a quarter
 * above that.
 *
 * Measured against `routing.openstreetmap.de/routed-car`, the router this app actually
 * calls, on 2026-09-05. Fourteen airport-to-bed pairs picked to stress every geography a
 * long road route comes from — a fjord, a mountain pass, an island with a car ferry, an
 * island with none, a sea crossing between two countries:
 *
 * | route | straight | road | time | straight-line pace |
 * | --- | --- | --- | --- | --- |
 * | Inverness airport to Portree, Skye | 129.2 km | 193.7 km | 2h 44m | 47.3 km/h |
 * | Barcelona airport to Placa de Catalunya | 12.3 km | 13.5 km | 17m | 42.5 km/h |
 * | Helsinki airport to Tallinn old town | 98.6 km | 105.4 km | 2h 38m | 37.3 km/h |
 * | Alesund airport to Geiranger | 76.0 km | 123.2 km | 2h 18m | 33.0 km/h |
 * | Gatwick to Kings Cross | 42.1 km | 51.5 km | 1h 18m | 32.3 km/h |
 * | Naples airport to Capri town | 37.3 km | 48.0 km | 1h 12m | 31.3 km/h |
 * | Bergen airport to Balestrand | 123.6 km | 198.6 km | 4h 1m | 30.8 km/h |
 * | Marseille airport to Ajaccio, Corsica | 333.5 km | 590.0 km | 12h 23m | 26.9 km/h |
 * | Athens airport to Aegina town | 50.0 km | 82.0 km | 1h 57m | 25.5 km/h |
 * | Vancouver airport to Victoria BC | 86.5 km | 154.2 km | 3h 58m | 21.8 km/h |
 * | Split airport to Vis town | 53.9 km | 79.6 km | 3h 30m | 15.4 km/h |
 * | Split airport to Hvar town | 42.3 km | 215.2 km | 4h 44m | 8.9 km/h |
 * | Athens airport to Thira, Santorini | 214.4 km | 268.9 km | 37h 31m | 5.7 km/h |
 * | Athens airport to Naxos town | 156.6 km | 180.0 km | 33h 0m | 4.7 km/h |
 *
 * The last two are the artefact, and it has one cause. OSRM's car profile prices a
 * `route=ferry` way from the way's own `duration` tag, and falls back to about 5 km/h when
 * there is none. Piraeus to Naxos is untagged, so the router spends 32h 31m on a crossing
 * the timetable does 3h 45m; Santorini is five such ways in a row. Marseille to Ajaccio is
 * the same journey with the tag present, and it comes back at a believable 12h 23m over
 * 590 km. Nothing about the route's shape gives this away, which is the point of the
 * "detour" column not being in this table: Naxos travels 1.15 times its straight line, the
 * most innocent ratio of the fourteen, and it is the worst answer here by a factor of nine.
 *
 * Everything above 8.9 km/h in that table is real and stays. Two of them are worth naming,
 * because they are the reason this is not a duration cap. Bergen airport to Balestrand on
 * the Sognefjord is four hours and one minute, and it is an ordinary drive to a village
 * people fly to Bergen for; issue #150 proposed a flat 240-minute cap for exactly this
 * problem, and it would have deleted that journey by sixty seconds. Marseille to Ajaccio is
 * twelve hours, entirely legitimate, and no flat cap survives contact with it at all.
 *
 * Split airport to Hvar town is the closest call in the table and it is kept on purpose.
 * 4h 44m to cover 42 km is a terrible way to reach Hvar, and it is a true one: OSRM cannot
 * board the passenger catamaran, so it takes the Drvenik car ferry and drives the length of
 * the island, which is what a car really has to do. The bound at its distance is 6h 38m,
 * so it survives with 40% to spare; Athens to Santorini, the artefact that comes closest to
 * passing, is refused with 27% to spare the other way. Those two margins are not equal and
 * are not meant to be. `providers/transfers/osrm.ts` errs the same direction with
 * `FASTEST_PLAUSIBLE_WALK_KM_PER_HOUR`, and #220's transit rule with
 * `SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR`: the bound must never delete a journey somebody
 * would actually take, so where the evidence runs out, it runs out on the loose side.
 *
 * What this therefore does NOT do is bound length. A twelve-hour drive to Corsica passes,
 * and should: length is sometimes the truth, and a traveller offered a bed 300 km from the
 * airport is better served by being told it is twelve hours away than by the row going
 * quiet. `pickBestTransfer` prefers transit, then walking, then taxi, then driving, so a
 * long drive only becomes the itinerary's pick when nothing else exists; and since #246 a
 * taxi past 30 km carries no fare estimate at all, with its own disclosure saying why.
 * This rule deletes disproportion, not distance.
 */
export const SLOWEST_USEFUL_ROAD_KM_PER_HOUR = 7.5;

/**
 * The longest driving or taxi transfer worth putting in front of a traveller, for two
 * points this far apart in a straight line. Issue #119's second half.
 *
 * Same shape as `maxPlausibleTransitMinutes` and for the same reason: no flat number is
 * right for a leg that is 2 km in one city and 200 km in another. Different numbers,
 * because the two modes fail differently. Transit is slow because it stops; a road route is
 * slow because the router is pricing a boat.
 */
export function maxPlausibleRoadMinutes(straightLineKm: number): Duration {
	const travel = (Math.max(0, straightLineKm) / SLOWEST_USEFUL_ROAD_KM_PER_HOUR) * 60;
	return (ROAD_FIXED_ALLOWANCE_MINUTES + travel) as Duration;
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
	/**
	 * Issue #266: the walk-out time `applyLandingBuffer` added to `duration`, kept rather
	 * than only spent.
	 *
	 * Set on the two legs that begin at a runway, and on nothing else. A leg ending at a
	 * departure gate is covered by the pre-boarding waiting time and never gets this
	 * padding at all. `undefined` therefore means either "this leg does not start at a
	 * runway" or "nobody applied the rule", and both of those are silence rather than a
	 * zero-minute buffer.
	 *
	 * It exists because folding a number into a total destroys it. The moment such a leg
	 * happens at is the flight's arrival plus exactly this, and once a flight swap moves
	 * the arrival, `algorithm/transit-schedule.ts` has to be able to work out the new
	 * moment to say that the timetable on this transfer was planned for the old one. It
	 * could not, so the row went on listing departures for a landing that no longer
	 * happens.
	 */
	landingBuffer?: Duration;
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
