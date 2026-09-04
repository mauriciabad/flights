/**
 * Whether a property's own NAME says it admits women only.
 *
 * A name check is not how anyone would choose to model this. It is what is available:
 * neither Booking nor Agoda exposes a structured field for a property-wide gender
 * restriction, the same gap booking-mapper.ts already documents for female-only rooms.
 *
 * The alternative was to keep reading nothing at all, which is how "Hostelle - women only
 * hostel London" reached a party with no female travellers as its cheapest option.
 *
 * Deliberately narrow. It requires the word "only", so an ordinary hostel whose name
 * merely contains "ladies" or "girls" is not quietly made unbookable for half the
 * searches. A false negative here costs a recommendation the traveller can reject on
 * sight; a false positive silently hides beds they could have booked.
 */
const WOMEN_ONLY =
  /\b(?:women|womens|women's|female|females|ladies|girls)[\s-]*only\b/i;

export function isWomenOnlyPropertyName(name: string): boolean {
  return WOMEN_ONLY.test(name);
}
