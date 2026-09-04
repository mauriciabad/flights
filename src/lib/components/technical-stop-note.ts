/**
 * How the interface says "this flight touches down on the way, and you stay on board".
 *
 * Issue #210 is explicit that the card must not let such a flight read as a nonstop, and
 * equally explicit about what the honest claim is: **1 stop, no plane change**. Both halves
 * are load-bearing. Drop the first and the traveller is surprised at Sal; drop the second
 * and they think they have a connection to make, which is the reading this app's entire
 * results screen otherwise trains them into.
 *
 * The wording lives here, as pure functions over a `FlightOffer`, rather than inline in a
 * component, so the claim is one string that can be asserted against rather than three
 * that can drift apart. It says only what `technicalStops` records: which airports, and how
 * long on the ground. It never says "quick" or "easy" — how a 50-minute stop feels is not
 * something this data supports a view on.
 */

import type { FlightOffer, TechnicalStop } from '../domain';
import { formatDuration } from '../format';

/** "1 stop, no plane change" — the short claim, for a row that already shows the route.
 * `undefined` for a genuine nonstop, which is most flights and needs no caption at all. */
export function technicalStopLabel(flight: FlightOffer): string | undefined {
	const stops = flight.technicalStops;
	if (!stops || stops.length === 0) return undefined;
	return `${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}, no plane change`;
}

/** "Stops in SID for 1h, everyone stays on board" — the full sentence, naming the airport
 * the short label deliberately leaves out. `undefined` for a nonstop. */
export function technicalStopDetail(flight: FlightOffer): string | undefined {
	const stops = flight.technicalStops;
	if (!stops || stops.length === 0) return undefined;
	const where = stops.map((stop: TechnicalStop) => `${stop.airport} for ${formatDuration(stop.groundTime)}`);
	const joined =
		where.length === 1
			? where[0]
			: `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}`;
	return `Stops in ${joined}, everyone stays on board.`;
}
