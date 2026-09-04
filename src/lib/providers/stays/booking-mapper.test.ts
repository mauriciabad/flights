import { describe, expect, it } from 'vitest';
import type { Property } from '../../domain';
import bookingRoomListIbis from './fixtures/booking-room-list-ibis.json';
import bookingSearchVienna from './fixtures/booking-search-vienna.json';
import type { BookingRoomListResponse, BookingSearchResponse } from './booking-types';
import { classifyBookingRoomKind, mapRoomListToStays, mapSearchResultToCandidate, toMoney } from './booking-mapper';

const searchFixture = bookingSearchVienna as BookingSearchResponse;
const ibisRoomListFixture = bookingRoomListIbis as BookingRoomListResponse;

describe('toMoney', () => {
	it('reads the numeric value, never the formatted currency-symbol strings', () => {
		// Real shape captured live 2026-09-04: `amount_rounded`/`amount_unrounded` are
		// "€ 65" / "€ 65.45" strings (non-breaking space included) that this function must
		// never parse — exactly the trap issue #10 warned about.
		expect(
			toMoney({ value: 65.45455, currency: 'EUR', amount_rounded: '€ 65', amount_unrounded: '€ 65.45' })
		).toEqual({ minorUnits: 6545, currency: 'EUR' });
	});

	it('returns undefined when value or currency is missing', () => {
		expect(toMoney({ currency: 'EUR' })).toBeUndefined();
		expect(toMoney({ value: 10 })).toBeUndefined();
	});
});

describe('classifyBookingRoomKind', () => {
	// Booking's real `is_dormitory` field was only confirmed live reading `0` for an
	// ordinary hotel's twin rooms (fixtures/booking-room-list-ibis.json) — the
	// 50-request/month budget did not stretch to a real dorm room, so the room-name
	// strings below are representative of Booking's own publicly documented dorm-room
	// naming convention (e.g. "Bed in X-Bed Dormitory Room"), not a live capture. See
	// booking-mapper.ts's doc comment and the PR body's "hostel data" section.
	it('trusts is_dormitory=1 even when the name alone would not obviously say dorm', () => {
		expect(classifyBookingRoomKind('Economy Room', 1)).toBe('dorm');
	});

	it('falls back to name matching when is_dormitory is 0 or absent', () => {
		expect(classifyBookingRoomKind('Bed in 6-Bed Dormitory Room', 0)).toBe('dorm');
		expect(classifyBookingRoomKind('Bed in 8-Bed Dormitory Room', undefined)).toBe('dorm');
	});

	it('flags a female-only dorm room from its name', () => {
		expect(classifyBookingRoomKind('Bed in 6-Bed Female Dormitory Room', 1)).toBe('female-dorm');
	});

	it('classifies ordinary rooms as private', () => {
		expect(classifyBookingRoomKind('Standard Twin Room', 0)).toBe('private');
		expect(classifyBookingRoomKind('Superior Twin Room', 0)).toBe('private');
	});

	it('treats a "private" name as private even if "dorm" also appears in it', () => {
		// Not confirmed live for Booking specifically, but Agoda showed this exact naming
		// pattern is real on at least one of these two providers (see
		// agoda-mapper.test.ts), so this adapter treats it as a real risk rather than an
		// Agoda-only quirk.
		expect(classifyBookingRoomKind('Private Room with 4 Dorm-Style Bunks', 0)).toBe('private');
	});
});

describe('mapSearchResultToCandidate (real fixture)', () => {
	it('maps a real Booking search result to a candidate', () => {
		const results = searchFixture.data?.result ?? [];
		const ibis = results.find((r) => r.hotel_id === 71662);
		const candidate = mapSearchResultToCandidate(ibis!);
		expect(candidate).toEqual({
			hotelId: 71662,
			property: {
				name: 'Ibis Vienna Airport',
				coordinates: { latitude: 48.1229461354855, longitude: 16.4396694302559 },
				images: [ibis!.main_photo_url],
				rating: 7.8
			},
			headlinePrice: { minorUnits: 6545, currency: 'EUR' }
		});
	});

	it('maps a missing review_score (null in the real response) to an undefined rating', () => {
		const results = searchFixture.data?.result ?? [];
		const canvas = results.find((r) => r.hotel_id === 16600815);
		const candidate = mapSearchResultToCandidate(canvas!);
		expect(candidate?.property.rating).toBeUndefined();
	});
});

describe('mapRoomListToStays (real fixture)', () => {
	it('groups an ordinary hotel’s twin rooms into a single cheapest private Stay', () => {
		const property: Property = {
			name: 'Ibis Vienna Airport',
			coordinates: { latitude: 48.1229461354855, longitude: 16.4396694302559 },
			images: []
		};
		const stays = mapRoomListToStays(property, ibisRoomListFixture);

		// Both real blocks (Standard Twin Room, Superior Twin Room) are is_dormitory=0
		// with no dorm-like name, so both fold into a single 'private' Stay at the
		// cheaper block's price (Standard Twin Room, 75.27275 EUR) — this hotel simply has
		// no dorm inventory to report, which is itself the honest, expected outcome for a
		// non-hostel property.
		expect(stays).toEqual([{ property, roomKind: 'private', pricePerNight: { minorUnits: 7527, currency: 'EUR' } }]);
	});
});
