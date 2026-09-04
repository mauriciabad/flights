import { test } from './support/fixtures';

/**
 * Editing a built itinerary (issue #18's fourth scenario): swap a flight, a transfer or
 * a stay for an alternative, and the totals and timeline update to match. Depends on
 * the itinerary timeline (#24), the transport/flight pickers (#28) and the stay picker
 * (#27), none of which exist yet.
 */
test.describe('itinerary editing', () => {
	test.skip('changing a flight updates the totals and the timeline', async () => {
		// Intent (issue #18): "Change a flight and confirm the totals and timeline
		// update." Once a built itinerary can be opened and a flight swapped for an
		// alternative (#28), assert the total price, total time and the timeline rows
		// all reflect the new flight, not the old one.
		// Blocked on: #13 (itinerary builder), #24 (itinerary timeline), #28
		// (transport/flight pickers).
	});
});
