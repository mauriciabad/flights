import type { Coordinates } from './coordinates';
import type { Money } from './money';

/**
 * Issue #1: "room kind (`dorm` | `private` | `female-dorm`)." A distinct female-dorm kind
 * matters because "Number of females" (brief line 34) decides whether those beds are even
 * available to filter in or out — a female dorm bed is not the same inventory as a mixed
 * dorm bed, so collapsing them into one `dorm` kind would lose that filter.
 */
export type RoomKind = 'dorm' | 'private' | 'female-dorm';

/**
 * The hostel/hotel itself, shared by every RoomKind priced within it.
 * Brief line 64: "Info about the hostels and rooms and images if possible."
 */
export interface Property {
	name: string;
	coordinates: Coordinates;
	images: string[];
	/** Not normalised to a common scale here — providers disagree on out-of-5 vs
	 * out-of-10, and that conversion is a display concern, not a domain fact. */
	rating?: number;
}

/**
 * One priced room-kind option at a property.
 * Issue #1: "Stay — property, room kind, price per night, coords, images, rating."
 * Brief line 65: "price per night in dorm and in private room (user can select to update
 * total)" — a property offering both a dorm bed and a private room is two Stay records,
 * not one Stay with two prices.
 */
export interface Stay {
	property: Property;
	roomKind: RoomKind;
	pricePerNight: Money;
}
