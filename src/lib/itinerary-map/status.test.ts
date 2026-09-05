import { describe, expect, it } from 'vitest';
import type { ItineraryMapModel } from './segments';
import { itineraryMapStatus } from './status';

/**
 * Issue #141's second defect, pinned where it can be checked without a browser: the map
 * went silent for any step it had no geometry for, both on screen and in its
 * `role="status"` region. The load-bearing assertion in this file is the last one, which
 * walks every id and refuses an empty string.
 */

const coordinates = { latitude: 41.8, longitude: 12.25 };

function model(overrides: Partial<ItineraryMapModel> = {}): ItineraryMapModel {
	return {
		segments: [
			{
				kind: 'point',
				id: 'connection-waiting',
				tone: 'stopover',
				markerKind: 'airport',
				label: 'Rome (FCO)',
				coordinates,
				precision: 'exact'
			},
			{
				kind: 'point',
				id: 'free-time',
				tone: 'stopover',
				markerKind: 'stay',
				label: 'Stopover in Rome',
				coordinates,
				precision: 'city'
			},
			{
				kind: 'line',
				id: 'transfer-to-origin-airport',
				role: 'transfer',
				tone: 'neutral',
				geometryKind: 'schematic',
				label: 'Transfer to BCN (straight-line estimate)',
				coordinates: [coordinates, { latitude: 41.9, longitude: 12.3 }]
			}
		],
		extraWaypoints: [],
		absentSegmentNotes: {
			'transfer-to-hotel': 'Nothing to draw. Nothing routed into the city for this stopover.'
		},
		...overrides
	};
}

describe('itineraryMapStatus', () => {
	it('says it is showing everything when nothing is picked', () => {
		expect(itineraryMapStatus(model(), null)).toEqual({
			text: 'Showing the whole route.',
			tone: 'neutral',
			isAbsence: false
		});
	});

	it('names the picked segment and carries its tone', () => {
		expect(itineraryMapStatus(model(), 'transfer-to-origin-airport')).toEqual({
			text: 'Showing Transfer to BCN (straight-line estimate).',
			tone: 'neutral',
			isAbsence: false
		});
		expect(itineraryMapStatus(model(), 'connection-waiting')).toEqual({
			text: 'Showing Rome (FCO).',
			tone: 'stopover',
			isAbsence: false
		});
	});

	it('warns that a bedless stopover is a city, not the address the zoom might suggest', () => {
		expect(itineraryMapStatus(model(), 'free-time').text).toBe(
			'Showing Stopover in Rome. No bed priced, so this is the connection city, not an address.'
		);
	});

	it('reads back the model own explanation for a step with no geometry', () => {
		expect(itineraryMapStatus(model(), 'transfer-to-hotel')).toEqual({
			text: 'Nothing to draw. Nothing routed into the city for this stopover.',
			tone: 'none',
			isAbsence: true
		});
	});

	it('still answers for an id from an itinerary that changed underneath the selection', () => {
		expect(itineraryMapStatus(model(), 'onward-flight')).toEqual({
			text: 'Nothing to draw. This step is not part of the itinerary on screen.',
			tone: 'none',
			isAbsence: true
		});
	});

	it('never returns an empty sentence, for any id, drawn or not', () => {
		const ids = [
			null,
			'origin-location',
			'transfer-to-origin-airport',
			'origin-waiting',
			'outbound-flight',
			'transfer-to-hotel',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting',
			'onward-flight',
			'transfer-to-destination-location',
			'destination-location'
		] as const;

		for (const id of ids) {
			const status = itineraryMapStatus(model(), id);
			expect(status.text.length, `empty status for ${id}`).toBeGreaterThan(0);
			expect(status.text.endsWith('.'), `unpunctuated status for ${id}`).toBe(true);
		}
	});
});
