import type { RoomKind } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import {
	BED_KINDS,
	BED_KIND_LABELS,
	NO_BED_KIND_FILTER,
	ROOM_KIND_LABELS,
	allowsBedKind,
	bedKindOf
} from './room-kind';

const EVERY_ROOM_KIND: RoomKind[] = ['dorm', 'private', 'female-dorm', 'male-dorm'];

describe('bedKindOf', () => {
	it('folds both restricted dorms into the plain dorm', () => {
		expect(bedKindOf('dorm')).toBe('dorm');
		expect(bedKindOf('female-dorm')).toBe('dorm');
		expect(bedKindOf('male-dorm')).toBe('dorm');
	});

	it('leaves a private room on its own', () => {
		expect(bedKindOf('private')).toBe('private');
	});

	it('answers for every room kind the domain has', () => {
		for (const roomKind of EVERY_ROOM_KIND) {
			expect(BED_KINDS).toContain(bedKindOf(roomKind));
		}
	});
});

describe('BED_KIND_LABELS', () => {
	// The chip that hides a room and the tile that prices it have to call it one thing,
	// which is the whole argument ROOM_KIND_LABELS was written for.
	it('reuses the room tiles own wording', () => {
		expect(BED_KIND_LABELS.dorm).toBe(ROOM_KIND_LABELS.dorm);
		expect(BED_KIND_LABELS.private).toBe(ROOM_KIND_LABELS.private);
	});
});

describe('allowsBedKind', () => {
	it('allows everything with no filter set', () => {
		for (const roomKind of EVERY_ROOM_KIND) {
			expect(allowsBedKind(undefined, roomKind)).toBe(true);
			expect(allowsBedKind(NO_BED_KIND_FILTER, roomKind)).toBe(true);
		}
	});

	it('keeps every dorm and drops the private room when narrowed to dorms', () => {
		const dormsOnly = new Set(['dorm' as const]);
		expect(allowsBedKind(dormsOnly, 'dorm')).toBe(true);
		expect(allowsBedKind(dormsOnly, 'female-dorm')).toBe(true);
		expect(allowsBedKind(dormsOnly, 'male-dorm')).toBe(true);
		expect(allowsBedKind(dormsOnly, 'private')).toBe(false);
	});

	it('drops every dorm when narrowed to private rooms', () => {
		const privateOnly = new Set(['private' as const]);
		expect(allowsBedKind(privateOnly, 'private')).toBe(true);
		expect(allowsBedKind(privateOnly, 'dorm')).toBe(false);
		expect(allowsBedKind(privateOnly, 'female-dorm')).toBe(false);
		expect(allowsBedKind(privateOnly, 'male-dorm')).toBe(false);
	});

	// Both chips on is the same request as neither, which is what stops the control having a
	// fourth state nobody asked for.
	it('narrows nothing when both kinds are chosen', () => {
		const both = new Set(BED_KINDS);
		for (const roomKind of EVERY_ROOM_KIND) {
			expect(allowsBedKind(both, roomKind)).toBe(true);
		}
	});
});
