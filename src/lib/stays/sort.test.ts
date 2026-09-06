import type { Duration, Money } from '$lib/domain';
import { describe, expect, it } from 'vitest';
import type { StayChoice } from './choice';
import type { StayReach } from './reach';
import { availableStaySortKeys, sortStayChoices, staySortValue } from './sort';

const minutes = (value: number) => value as Duration;

function reach(walk?: number, taxi?: number, transit?: number): StayReach {
	return {
		walk: walk === undefined ? { kind: 'no-route' } : { kind: 'routed', minutes: minutes(walk) },
		transit: transit === undefined ? { kind: 'not-asked' } : { kind: 'routed', minutes: minutes(transit) },
		taxi: taxi === undefined ? { kind: 'no-route' } : { kind: 'routed', minutes: minutes(taxi) }
	};
}

interface RowSpec {
	key: string;
	rate?: Money;
	centreKm?: number;
	reach?: StayReach;
}

function row({ key, rate, centreKm, reach: reachFor }: RowSpec): StayChoice {
	const property = { name: key, coordinates: { latitude: 0, longitude: 0 }, images: [] };
	return {
		key,
		group: { options: [] },
		property,
		cheapest: rate ? { stay: { property, roomKind: 'dorm', pricePerNight: rate } } : undefined,
		distanceToAirportKm: 5,
		distanceToCentreKm: centreKm,
		reach: reachFor,
		comparison: { kind: 'unbookable' },
		isPicked: false
	};
}

const eur = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

const cheapFarWalk = row({ key: 'cheap', rate: eur(1300), centreKm: 9.4, reach: reach(undefined, 41) });
const dearNearWalk = row({ key: 'dear', rate: eur(5282), centreKm: 0.8, reach: reach(12, 4) });
const middling = row({ key: 'middling', rate: eur(3040), centreKm: 3.1, reach: reach(38, 9) });
const list = [cheapFarWalk, dearNearWalk, middling];

const keysOf = (choices: readonly StayChoice[]) => choices.map((choice) => choice.key);

describe('sortStayChoices', () => {
	/**
	 * Issue #406's acceptance opens with this. `rankProperties` decides the incoming order and
	 * nothing here is allowed to move it, so the default is the identity and can be checked as
	 * one rather than reasoned about.
	 */
	it('leaves the recommended order exactly as it arrived', () => {
		expect(keysOf(sortStayChoices(list, 'recommended', 'EUR'))).toEqual(['cheap', 'dear', 'middling']);
	});

	it('sorts cheapest room first', () => {
		expect(keysOf(sortStayChoices(list, 'price', 'EUR'))).toEqual(['cheap', 'middling', 'dear']);
	});

	it('sorts closest to the centre first', () => {
		expect(keysOf(sortStayChoices(list, 'centre', 'EUR'))).toEqual(['dear', 'middling', 'cheap']);
	});

	it('sorts on each mode separately, so the shortest walk and the shortest taxi are different orders', () => {
		expect(keysOf(sortStayChoices(list, 'walk', 'EUR'))).toEqual(['dear', 'middling', 'cheap']);
		expect(keysOf(sortStayChoices(list, 'taxi', 'EUR'))).toEqual(['dear', 'middling', 'cheap']);
	});

	/**
	 * The case issue #406 names: "A property with no transit journey cannot be sorted by
	 * transit time, and it must not silently sort as zero or vanish." `cheap` has no walk, so
	 * it goes last and stays on the list.
	 */
	it('puts a row the key cannot measure last rather than at zero, and keeps it visible', () => {
		const sorted = sortStayChoices(list, 'walk', 'EUR');
		expect(sorted).toHaveLength(3);
		expect(sorted.at(-1)?.key).toBe('cheap');
	});

	it('keeps the recommended order among the rows it cannot measure', () => {
		const noReach = [row({ key: 'a' }), row({ key: 'b' }), row({ key: 'c' })];
		expect(keysOf(sortStayChoices(noReach, 'taxi'))).toEqual(['a', 'b', 'c']);
	});

	/**
	 * This app converts no currency (`pricing.ts` throws rather than guess a rate), so a room
	 * quoted in another one is not cheap or dear, it is uncomparable. Sorting its minor units
	 * against euro cents would put a 4,500 JPY bed above a 30.40 EUR one.
	 */
	it('refuses to compare two currencies and sorts the odd one out last', () => {
		const yen = row({ key: 'yen', rate: { minorUnits: 450000, currency: 'JPY' } });
		expect(keysOf(sortStayChoices([yen, dearNearWalk, cheapFarWalk], 'price', 'EUR'))).toEqual([
			'cheap',
			'dear',
			'yen'
		]);
	});

	it('does not mutate the list it was given', () => {
		const before = keysOf(list);
		sortStayChoices(list, 'price', 'EUR');
		expect(keysOf(list)).toEqual(before);
	});
});

describe('staySortValue', () => {
	it('measures nothing for recommended, which is what makes every comparison a tie', () => {
		expect(staySortValue('recommended', dearNearWalk, 'EUR')).toBeUndefined();
	});

	it('reads only a routed reach, never an implausible or unasked one', () => {
		const implausible = row({
			key: 'x',
			reach: {
				walk: { kind: 'implausible', minutes: minutes(702), limit: minutes(45) },
				transit: { kind: 'not-asked' },
				taxi: { kind: 'pending' }
			}
		});
		expect(staySortValue('walk', implausible)).toBeUndefined();
		expect(staySortValue('transit', implausible)).toBeUndefined();
		expect(staySortValue('taxi', implausible)).toBeUndefined();
	});
});

describe('availableStaySortKeys', () => {
	/**
	 * The shape change against what issue #406 implies, and the reason for it. Transit has no
	 * batch lookup (`fetch-reach.ts` has the measurement), so on an ordinary list nothing has a
	 * bus time. Offering "shortest bus ride" anyway would be a control that rearranges nothing
	 * while looking broken, so a mode earns its key by having an answer on at least one row.
	 */
	it('offers a mode only where something was actually routed for it', () => {
		expect(availableStaySortKeys(list, 'EUR')).toEqual(['recommended', 'price', 'centre', 'walk', 'taxi']);
	});

	it('adds the transit key as soon as one property has a bus time', () => {
		const withBus = [...list, row({ key: 'bussed', reach: reach(10, 5, 22) })];
		expect(availableStaySortKeys(withBus, 'EUR')).toContain('transit');
	});

	it('drops the centre key on an airport with no hand-checked city point', () => {
		const noCentre = [row({ key: 'a', rate: eur(1000) })];
		expect(availableStaySortKeys(noCentre, 'EUR')).toEqual(['recommended', 'price']);
	});

	it('always offers recommended, even for a list with nothing else to sort on', () => {
		expect(availableStaySortKeys([row({ key: 'a' })])).toEqual(['recommended']);
		expect(availableStaySortKeys([])).toEqual(['recommended']);
	});
});
