import { describe, expect, it } from 'vitest';
import type { Property } from '../../domain';
import bookingRoomListIbis from './fixtures/booking-room-list-ibis.json';
import bookingSearchVienna from './fixtures/booking-search-vienna.json';
import type { BookingRoomListResponse, BookingSearchResponse } from './booking-types';
import {
	classifyBookingRoomKind,
	mapRoomBlocksToStays,
	mapRoomListToStays,
	mapSearchResultToCandidate,
	toMoney
} from './booking-mapper';

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

	it('returns undefined rather than NaN/0 when value is not actually a number (issue #68)', () => {
		// booking-types.ts declares `value` as `number`, but that is only a compile-time
		// hint — a live scraper response is free to send anything. `null * 100 === 0` in
		// JavaScript, so an unchecked null would silently become a real, wrong "free" price.
		expect(toMoney({ value: null as unknown as number, currency: 'EUR' })).toBeUndefined();
		expect(toMoney({ value: 'sixty-five' as unknown as number, currency: 'EUR' })).toBeUndefined();
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

	/**
	 * Issue #68: corrupts one field of the same real, good fixture per case and asserts the
	 * candidate is dropped rather than crashing or carrying a wrongly-typed value through.
	 * No live evidence of Booking ever sending these, but the risk is the same one this
	 * whole sweep is about, and `booking-types.ts`'s declared types are a compile-time hint,
	 * not a runtime guarantee.
	 */
	describe('runtime validation of an unverified field type (corrupted fixture)', () => {
		const results = searchFixture.data?.result ?? [];
		const ibis = results.find((r) => r.hotel_id === 71662)!;

		it('drops a candidate whose price value is null rather than reporting a free stay', () => {
			const corrupted = {
				...ibis,
				composite_price_breakdown: { gross_amount_per_night: { value: null as unknown as number, currency: 'EUR' } }
			};
			expect(mapSearchResultToCandidate(corrupted)).toBeUndefined();
		});

		it('drops a candidate whose price value is a non-numeric string rather than reporting NaN', () => {
			const corrupted = {
				...ibis,
				composite_price_breakdown: {
					gross_amount_per_night: { value: 'sixty-five' as unknown as number, currency: 'EUR' }
				}
			};
			expect(mapSearchResultToCandidate(corrupted)).toBeUndefined();
		});

		it('drops a candidate whose latitude is a string instead of coercing or crashing', () => {
			const corrupted = { ...ibis, latitude: '48.12' as unknown as number };
			expect(mapSearchResultToCandidate(corrupted)).toBeUndefined();
		});

		it('drops a candidate whose hotel_name is a number rather than carrying it through wrongly typed', () => {
			const corrupted = { ...ibis, hotel_name: 12345 as unknown as string };
			expect(mapSearchResultToCandidate(corrupted)).toBeUndefined();
		});

		it('drops a candidate whose hotel_id is a string rather than carrying a wrongly-typed id', () => {
			const corrupted = { ...ibis, hotel_id: '71662' as unknown as number };
			expect(mapSearchResultToCandidate(corrupted)).toBeUndefined();
		});
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

	it('treats a non-array block as no rooms rather than throwing on for...of (issue #68)', () => {
		const property: Property = {
			name: 'Ibis Vienna Airport',
			coordinates: { latitude: 48.1229461354855, longitude: 16.4396694302559 },
			images: []
		};
		const corrupted = { data: { block: { not: 'an array' } as never } };
		expect(() => mapRoomListToStays(property, corrupted)).not.toThrow();
		expect(mapRoomListToStays(property, corrupted)).toEqual([]);
	});

	it('drops a room block whose price is a non-numeric string rather than reporting NaN', () => {
		const property: Property = {
			name: 'Ibis Vienna Airport',
			coordinates: { latitude: 48.1229461354855, longitude: 16.4396694302559 },
			images: []
		};
		const corruptedBlock = {
			room_name: 'Standard Twin Room',
			is_dormitory: 0 as const,
			product_price_breakdown: {
				gross_amount_per_night: { value: 'bad-data' as unknown as number, currency: 'EUR' }
			}
		};
		expect(mapRoomBlocksToStays(property, [corruptedBlock])).toEqual([]);
	});
});
