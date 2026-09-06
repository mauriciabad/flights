import { describe, expect, it } from 'vitest';
import { deriveItinerary } from '../algorithm/build';
import type {
	Airport,
	Duration,
	FlightOffer,
	Itinerary,
	LocalDateTime,
	Money,
	Transfer,
	TransitSchedule
} from '../domain';
import { TRIP_STRIP_SCALE, segmentIdOf, splitFreeTimeAtLocalMidnight, sqrtShares, tripStrip } from './trip-strip';

function at(local: string): LocalDateTime {
	return { local, timeZone: 'Europe/Vienna', utcOffsetMinutes: 120 };
}

function airport(iataCode: string): Airport {
	const city = { name: iataCode, coordinates: { latitude: 0, longitude: 0 }, country: { isoCode: 'XX', name: 'X' } };
	return {
		iataCode,
		name: `${iataCode} Airport`,
		coordinates: { latitude: 0, longitude: 0 },
		city,
		country: city.country,
		sizeClass: 'medium'
	};
}

const eur = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

function flight(from: string, to: string, departure: string, arrival: string, minutes: number): FlightOffer {
	return {
		carrier: { iataCode: 'FR', name: 'Ryanair' },
		flightNumber: 'FR100',
		departureAirport: from,
		arrivalAirport: to,
		departure: at(departure),
		arrival: at(arrival),
		duration: minutes as Duration,
		price: eur(9000),
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 },
		deepLink: 'https://example.invalid/book'
	};
}

function transfer(mode: Transfer['mode'], minutes: number): Transfer {
	return { mode, duration: minutes as Duration, legs: [{ mode, duration: minutes as Duration }] };
}

interface Shape {
	/** Local wall-clock at the origin, e.g. "2026-10-06T08:00:00". */
	departs: string;
	outboundMinutes: number;
	/** Wall-clock minutes between the outbound landing and the onward take-off. */
	stopoverMinutes: number;
	onwardMinutes: number;
	toCity?: Transfer;
	toAirport?: Transfer;
	toOriginAirport?: Transfer;
	toDestination?: Transfer;
	waiting?: number;
}

/**
 * Builds an itinerary the way `algorithm/build.ts` would: free time runs from the landing
 * plus the leg into the city to the take-off minus the buffer and the leg back. Every
 * clock reading is a wall-clock string at one offset, so the numbers below are exact.
 */
function makeItinerary(shape: Shape): Itinerary {
	const waiting = shape.waiting ?? 120;
	const iso = (date: Date) => date.toISOString().slice(0, 19);
	const departure = new Date(`${shape.departs}Z`);
	const landing = new Date(departure.getTime() + shape.outboundMinutes * 60_000);
	const onwardDeparture = new Date(landing.getTime() + shape.stopoverMinutes * 60_000);
	const onwardArrival = new Date(onwardDeparture.getTime() + shape.onwardMinutes * 60_000);
	const freeStart = new Date(landing.getTime() + (shape.toCity?.duration ?? 0) * 60_000);
	const freeEnd = new Date(onwardDeparture.getTime() - (waiting + (shape.toAirport?.duration ?? 0)) * 60_000);
	const freeMinutes = Math.round((freeEnd.getTime() - freeStart.getTime()) / 60_000);

	const outboundFlight = flight('BVC', 'LGW', iso(departure), iso(landing), shape.outboundMinutes);
	const onwardFlight = flight('LGW', 'PFO', iso(onwardDeparture), iso(onwardArrival), shape.onwardMinutes);

	return {
		transferToOriginAirport: shape.toOriginAirport,
		originAirport: airport('BVC'),
		originWaitingTime: waiting as Duration,
		outboundFlight,
		transferToHotel: shape.toCity,
		freeTime: { start: at(iso(freeStart)), end: at(iso(freeEnd)), duration: freeMinutes as Duration },
		nightsInConnection: 0,
		transferToConnectionAirport: shape.toAirport,
		connectionWaitingTime: waiting as Duration,
		onwardFlight,
		destinationAirport: airport('PFO'),
		transferToDestinationLocation: shape.toDestination,
		totalPrice: eur(18000),
		travellers: 1,
		times: {
			inFlight: (shape.outboundMinutes + shape.onwardMinutes) as Duration,
			airportWaiting: (waiting * 2) as Duration,
			connectionAirportWaiting: waiting as Duration,
			originAirportWaiting: waiting as Duration,
			free: freeMinutes as Duration,
			total: (shape.outboundMinutes + shape.stopoverMinutes + shape.onwardMinutes) as Duration
		}
	};
}

describe('sqrtShares', () => {
	it('always sums to one, whatever the ratio', () => {
		for (const minutes of [[1, 1, 1], [120, 4320, 185], [5, 5, 500], [0, 100, 0], [1, 0, 0], [25, 1440, 1440, 25]]) {
			const total = sqrtShares(minutes).reduce((sum, share) => sum + share, 0);
			expect(total).toBeCloseTo(1, 10);
		}
	});

	it('draws a part four times as long exactly twice as wide, which is what the label on the strip promises', () => {
		const [short, long] = sqrtShares([30, 120]);
		expect(long! / short!).toBeCloseTo(2, 10);
	});

	it('keeps a longer part wider than a shorter one, even at the extremes a real trip reaches', () => {
		// A 25-minute bus beside three full days: 1:57.6 in minutes, about 1:7.6 on the bar.
		const shares = sqrtShares([25, 1440, 1440, 1440]);
		expect(shares[1]).toBeGreaterThan(shares[0]!);
		expect(shares[1]! / shares[0]!).toBeCloseTo(Math.sqrt(1440 / 25), 10);
	});

	it('keeps every part visible: a 15-minute walk on a week-long stopover is still over one percent of the bar', () => {
		const week = [120, 420, 15, 300, ...Array<number>(7).fill(1440), 600, 15, 120, 240];
		const shares = sqrtShares(week);
		expect(Math.min(...shares)).toBeGreaterThan(0.01);
	});

	it('splits evenly rather than dividing by zero when nothing has any length', () => {
		for (const share of sqrtShares([0, 0, 0])) expect(share).toBeCloseTo(1 / 3, 10);
	});

	it('treats a negative length as zero rather than producing NaN', () => {
		expect(sqrtShares([-30, 120])).toEqual([0, 1]);
	});
});

describe('splitFreeTimeAtLocalMidnight', () => {
	it('cuts an overnight window into an evening and a morning on the local clock', () => {
		// The reference route (docs/prompts/007): lands 20:30 at LGW, 40 minutes into town,
		// out again 12:40 next day for a 15:20 flight with a 2h buffer.
		const pieces = splitFreeTimeAtLocalMidnight(at('2026-10-06T21:10:00'), at('2026-10-07T12:40:00'));
		expect(pieces).toEqual([
			{
				date: '2026-10-06',
				start: '2026-10-06T21:10:00',
				end: '2026-10-07T00:00:00',
				minutes: 170,
				wholeDay: false,
				startsAtMidnight: false,
				endsAtMidnight: true
			},
			{
				date: '2026-10-07',
				start: '2026-10-07T00:00:00',
				end: '2026-10-07T12:40:00',
				minutes: 760,
				wholeDay: false,
				startsAtMidnight: true,
				endsAtMidnight: false
			}
		]);
	});

	it('marks every full day between the first evening and the last morning', () => {
		const pieces = splitFreeTimeAtLocalMidnight(at('2026-10-02T19:00:00'), at('2026-10-05T10:00:00'));
		expect(pieces.map((piece) => [piece.date, piece.minutes, piece.wholeDay])).toEqual([
			['2026-10-02', 300, false],
			['2026-10-03', 1440, true],
			['2026-10-04', 1440, true],
			['2026-10-05', 600, false]
		]);
		expect(pieces.reduce((sum, piece) => sum + piece.minutes, 0)).toBe(3 * 24 * 60 - 9 * 60);
	});

	it('reads the day off the airport clock, never off UTC', () => {
		// 00:30 to 06:00 local. In UTC that window starts on the previous day, and a split
		// that normalised to UTC would report an evening piece on a day the traveller never
		// saw. AGENTS.md: "that is how an overnight connection silently loses a night."
		const pieces = splitFreeTimeAtLocalMidnight(at('2026-10-07T00:30:00'), at('2026-10-07T06:00:00'));
		expect(pieces).toEqual([
			{
				date: '2026-10-07',
				start: '2026-10-07T00:30:00',
				end: '2026-10-07T06:00:00',
				minutes: 330,
				wholeDay: false,
				startsAtMidnight: false,
				endsAtMidnight: false
			}
		]);
	});

	it('keeps a same-day window as one piece with no midnight flags', () => {
		expect(splitFreeTimeAtLocalMidnight(at('2026-10-06T10:00:00'), at('2026-10-06T14:00:00'))).toEqual([
			{
				date: '2026-10-06',
				start: '2026-10-06T10:00:00',
				end: '2026-10-06T14:00:00',
				minutes: 240,
				wholeDay: false,
				startsAtMidnight: false,
				endsAtMidnight: false
			}
		]);
	});

	it('starts with the morning when the window opens exactly at midnight, with no empty evening before it', () => {
		const pieces = splitFreeTimeAtLocalMidnight(at('2026-10-07T00:00:00'), at('2026-10-07T09:00:00'));
		expect(pieces).toHaveLength(1);
		expect(pieces[0]).toMatchObject({ date: '2026-10-07', minutes: 540, startsAtMidnight: true });
	});

	it('yields nothing for an empty or inverted window rather than a negative piece', () => {
		expect(splitFreeTimeAtLocalMidnight(at('2026-10-06T10:00:00'), at('2026-10-06T10:00:00'))).toEqual([]);
		expect(splitFreeTimeAtLocalMidnight(at('2026-10-06T10:00:00'), at('2026-10-06T09:00:00'))).toEqual([]);
	});
});

describe('tripStrip', () => {
	it('lists every part of the schedule in order, with the legs that exist and none that do not', () => {
		const strip = tripStrip(
			makeItinerary({
				departs: '2026-10-06T08:00:00',
				outboundMinutes: 470,
				stopoverMinutes: 18 * 60 + 50,
				onwardMinutes: 400,
				toCity: transfer('transit', 40),
				toAirport: transfer('transit', 40)
			})
		);
		expect(strip.segments.map((segment) => segment.kind)).toEqual([
			'wait',
			'flight',
			'transfer',
			'free',
			'free',
			'transfer',
			'wait',
			'flight'
		]);
		expect(strip.scale).toBe(TRIP_STRIP_SCALE);
		expect(strip.outboundIndex).toBe(1);
		expect(strip.onwardIndex).toBe(7);
	});

	it('gives every part the clock readings it runs between, with no gap and no overlap', () => {
		const strip = tripStrip(
			makeItinerary({
				departs: '2026-10-06T08:00:00',
				outboundMinutes: 470,
				stopoverMinutes: 18 * 60 + 50,
				onwardMinutes: 400,
				toOriginAirport: transfer('drive', 35),
				toCity: transfer('transit', 40),
				toAirport: transfer('transit', 40),
				toDestination: transfer('walk', 20)
			})
		);
		expect(strip.segments.map((segment) => [segment.start.local, segment.end.local])).toEqual([
			['2026-10-06T05:25:00', '2026-10-06T06:00:00'],
			['2026-10-06T06:00:00', '2026-10-06T08:00:00'],
			['2026-10-06T08:00:00', '2026-10-06T15:50:00'],
			['2026-10-06T15:50:00', '2026-10-06T16:30:00'],
			['2026-10-06T16:30:00', '2026-10-07T00:00:00'],
			['2026-10-07T00:00:00', '2026-10-07T08:00:00'],
			['2026-10-07T08:00:00', '2026-10-07T08:40:00'],
			['2026-10-07T08:40:00', '2026-10-07T10:40:00'],
			['2026-10-07T10:40:00', '2026-10-07T17:20:00'],
			['2026-10-07T17:20:00', '2026-10-07T17:40:00']
		]);
	});

	it('measures each part between its own two readings, so the drawn width and the printed time agree', () => {
		const strip = tripStrip(
			makeItinerary({
				departs: '2026-10-06T08:00:00',
				outboundMinutes: 470,
				stopoverMinutes: 18 * 60 + 50,
				onwardMinutes: 400,
				toCity: transfer('transit', 40),
				toAirport: transfer('transit', 40)
			})
		);
		for (const segment of strip.segments) {
			const elapsed = (Date.parse(`${segment.end.local}Z`) - Date.parse(`${segment.start.local}Z`)) / 60_000;
			expect(elapsed).toBe(segment.minutes);
		}
	});

	it('reads the stopover ends off freeTime rather than re-deriving them, so the block and the strip agree', () => {
		const itinerary = makeItinerary({
			departs: '2026-10-06T08:00:00',
			outboundMinutes: 470,
			stopoverMinutes: 18 * 60 + 50,
			onwardMinutes: 400,
			toCity: transfer('transit', 40),
			toAirport: transfer('transit', 40)
		});
		const free = tripStrip(itinerary).segments.filter((segment) => segment.kind === 'free');
		expect(free[0]?.start.local).toBe(itinerary.freeTime.start.local);
		expect(free.at(-1)?.end.local).toBe(itinerary.freeTime.end.local);
	});

	it('keeps every stopover reading on the stopover clock, never on the viewer\'s', () => {
		const itinerary = makeItinerary({
			departs: '2026-10-06T08:00:00',
			outboundMinutes: 470,
			stopoverMinutes: 18 * 60 + 50,
			onwardMinutes: 400,
			toCity: transfer('transit', 40)
		});
		for (const segment of tripStrip(itinerary).segments) {
			if (segment.kind !== 'free') continue;
			expect(segment.start.timeZone).toBe(itinerary.freeTime.start.timeZone);
			expect(segment.start.utcOffsetMinutes).toBe(itinerary.freeTime.start.utcOffsetMinutes);
			expect(segment.end.utcOffsetMinutes).toBe(itinerary.freeTime.start.utcOffsetMinutes);
		}
	});

	it('hands each part the thing it stands for, so a reader never has to guess which leg it has', () => {
		const toCity = transfer('transit', 40);
		const itinerary = makeItinerary({
			departs: '2026-10-06T08:00:00',
			outboundMinutes: 470,
			stopoverMinutes: 18 * 60 + 50,
			onwardMinutes: 400,
			toCity
		});
		const strip = tripStrip(itinerary);
		const flights = strip.segments.filter((segment) => segment.kind === 'flight');
		const waits = strip.segments.filter((segment) => segment.kind === 'wait');
		const transfers = strip.segments.filter((segment) => segment.kind === 'transfer');
		expect(flights.map((segment) => segment.offer)).toEqual([itinerary.outboundFlight, itinerary.onwardFlight]);
		expect(waits.map((segment) => segment.beforeFlight)).toEqual([itinerary.outboundFlight, itinerary.onwardFlight]);
		expect(transfers.map((segment) => segment.transfer)).toEqual([toCity]);
	});

	it('draws the outer ground legs only when the query gave it somewhere to start or finish', () => {
		const bare = tripStrip(
			makeItinerary({ departs: '2026-10-06T08:00:00', outboundMinutes: 120, stopoverMinutes: 360, onwardMinutes: 120 })
		);
		expect(bare.segments[0]?.kind).toBe('wait');
		expect(bare.segments.at(-1)?.kind).toBe('flight');

		const doorToDoor = tripStrip(
			makeItinerary({
				departs: '2026-10-06T08:00:00',
				outboundMinutes: 120,
				stopoverMinutes: 360,
				onwardMinutes: 120,
				toOriginAirport: transfer('drive', 35),
				toDestination: transfer('walk', 20)
			})
		);
		expect(doorToDoor.segments[0]).toMatchObject({ kind: 'transfer', leg: 'to-origin-airport', mode: 'drive', minutes: 35 });
		expect(doorToDoor.segments.at(-1)).toMatchObject({ kind: 'transfer', leg: 'to-destination', mode: 'walk', minutes: 20 });
		expect(doorToDoor.outboundIndex).toBe(2);
	});

	it('adds the parts up to the door-to-door total, so nothing between the flights is dropped', () => {
		const itinerary = makeItinerary({
			departs: '2026-10-06T08:00:00',
			outboundMinutes: 470,
			stopoverMinutes: 3 * 24 * 60 + 90,
			onwardMinutes: 400,
			toCity: transfer('transit', 40),
			toAirport: transfer('taxi', 25),
			toOriginAirport: transfer('drive', 35),
			toDestination: transfer('walk', 20)
		});
		const strip = tripStrip(itinerary);
		const expected = 35 + 120 + 470 + 40 + itinerary.freeTime.duration + 25 + 120 + 400 + 20;
		expect(strip.totalMinutes).toBe(expected);
		expect(strip.segments.reduce((sum, segment) => sum + segment.minutes, 0)).toBe(expected);
		expect(strip.segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1, 10);
	});

	it('names the airports and carriers from the flights themselves', () => {
		const strip = tripStrip(
			makeItinerary({ departs: '2026-10-06T08:00:00', outboundMinutes: 120, stopoverMinutes: 360, onwardMinutes: 185 })
		);
		expect(strip.segments[0]).toMatchObject({ kind: 'wait', airport: 'BVC', minutes: 120 });
		expect(strip.segments[strip.outboundIndex]).toMatchObject({ kind: 'flight', from: 'BVC', to: 'LGW', minutes: 120 });
		expect(strip.segments[strip.onwardIndex - 1]).toMatchObject({ kind: 'wait', airport: 'LGW', minutes: 120 });
		expect(strip.segments[strip.onwardIndex]).toMatchObject({ kind: 'flight', from: 'LGW', to: 'PFO', minutes: 185 });
	});

	it('splits a three-night stopover into an evening, whole days and a morning, each its own cell', () => {
		// Lands Friday 18:00, leaves Monday 15:00 with a 2h buffer: Friday evening, all
		// Saturday, all Sunday, Monday morning. The shape the owner asked for by name.
		const strip = tripStrip(
			makeItinerary({
				departs: '2026-10-02T14:00:00',
				outboundMinutes: 240,
				stopoverMinutes: 2 * 24 * 60 + 21 * 60,
				onwardMinutes: 180
			})
		);
		const free = strip.segments.filter((segment) => segment.kind === 'free');
		expect(free.map((piece) => [piece.date, piece.wholeDay])).toEqual([
			['2026-10-02', false],
			['2026-10-03', true],
			['2026-10-04', true],
			['2026-10-05', false]
		]);
		// Both whole days get the same width, which is what makes nights countable.
		expect(free[1]!.share).toBeCloseTo(free[2]!.share, 12);
	});

	it('draws no free cell at all when the buffers and legs eat the whole layover', () => {
		// A 2h 40m layover with a 2h buffer and two 20-minute legs leaves zero free minutes;
		// `build.ts` keeps such an itinerary. The strip draws no empty teal cell for it,
		// because that cell would claim a duration nobody has.
		const strip = tripStrip(
			makeItinerary({
				departs: '2026-10-06T08:00:00',
				outboundMinutes: 120,
				stopoverMinutes: 160,
				onwardMinutes: 120,
				toCity: transfer('walk', 20),
				toAirport: transfer('walk', 20)
			})
		);
		expect(strip.segments.some((segment) => segment.kind === 'free')).toBe(false);
		expect(strip.segments.map((segment) => segment.kind)).toEqual(['wait', 'flight', 'transfer', 'transfer', 'wait', 'flight']);
	});

	it('keeps a wait edited down to zero as a segment, so an edited value is still a present one', () => {
		const strip = tripStrip(
			makeItinerary({ departs: '2026-10-06T08:00:00', outboundMinutes: 120, stopoverMinutes: 360, onwardMinutes: 120, waiting: 0 })
		);
		expect(strip.segments[0]).toMatchObject({ kind: 'wait', minutes: 0, share: 0 });
	});
});

describe('segmentIdOf', () => {
	// Every ground leg present, so the strip has one segment of each kind on each side of
	// the stopover and the two waits and two flights have to be told apart by position
	// rather than by anything stored on them.
	const strip = tripStrip(
		makeItinerary({
			departs: '2026-10-06T08:00:00',
			outboundMinutes: 120,
			stopoverMinutes: 2000,
			onwardMinutes: 120,
			toOriginAirport: transfer('taxi', 30),
			toCity: transfer('transit', 40),
			toAirport: transfer('transit', 40),
			toDestination: transfer('walk', 15)
		})
	);

	it('names every segment in the vocabulary the map and the timeline already share', () => {
		expect(strip.segments.map((_, index) => segmentIdOf(strip, index))).toEqual([
			'transfer-to-origin-airport',
			'origin-waiting',
			'outbound-flight',
			'transfer-to-hotel',
			'free-time',
			'free-time',
			'transfer-to-connection-airport',
			'connection-waiting',
			'onward-flight',
			'transfer-to-destination-location'
		]);
	});

	it('tells the two waits apart by which flight they precede, not by the airport code', () => {
		// The reason this needs saying: a trip that returns through the airport it left
		// from would give both waits the same code, and reading the code would collapse
		// them into one selection.
		const waits = strip.segments.flatMap((segment, index) => (segment.kind === 'wait' ? [segmentIdOf(strip, index)] : []));
		expect(waits).toEqual(['origin-waiting', 'connection-waiting']);
	});

	it('gives every free-time day the one stopover id, so a run of cells selects one thing', () => {
		const free = strip.segments.flatMap((segment, index) => (segment.kind === 'free' ? [segmentIdOf(strip, index)] : []));
		expect(free.length).toBeGreaterThan(1);
		expect(new Set(free)).toEqual(new Set(['free-time']));
	});
});

/**
 * Issue #368, the same production numbers `algorithm/build.test.ts` pins: BCN to BVC via
 * Porto, landing 6:50am, boarding 6:10am the next morning, with both in-city rides on a real
 * Transitous timetable.
 *
 * The strip drew a 67-minute cell across the 2h 35m between the stopover and the buffer,
 * because it read `Transfer.duration` and `connectionWaitingTime` instead of asking what the
 * layover actually leaves.
 */
describe('the strip, over a layover with a timetable in it', () => {
	function scheduled(minutes: number, schedule: TransitSchedule, landingBuffer?: number): Transfer {
		return {
			mode: 'transit',
			duration: minutes as Duration,
			legs: [{ mode: 'transit', duration: minutes as Duration }],
			transitSchedule: schedule,
			landingBuffer: landingBuffer === undefined ? undefined : (landingBuffer as Duration)
		};
	}

	function porto() {
		const base = makeItinerary({
			departs: '2026-09-16T04:50:00',
			outboundMinutes: 120,
			stopoverMinutes: 1400,
			onwardMinutes: 270,
			toCity: scheduled(
				69,
				{
					intended: at('2026-09-16T07:30:00'),
					arrival: at('2026-09-16T08:06:00'),
					following: [at('2026-09-16T07:41:00')],
					plannedFor: { time: at('2026-09-16T07:20:00'), arriveBy: false }
				},
				30
			),
			toAirport: scheduled(67, {
				intended: at('2026-09-17T01:35:00'),
				arrival: at('2026-09-17T02:38:00'),
				following: [],
				plannedFor: { time: at('2026-09-17T04:10:00'), arriveBy: true }
			})
		});
		return tripStrip({ ...base, ...deriveItinerary(base) });
	}

	function cell(kind: string, leg?: string) {
		const found = porto().segments.find(
			(segment) => segment.kind === kind && (leg === undefined || (segment as { leg?: string }).leg === leg)
		);
		if (!found) throw new Error(`no ${kind} ${leg ?? ''} cell`);
		return found;
	}

	it('draws the ride into town as long as it really takes, wait for the coach included', () => {
		// 6:50am to 8:06am, not the 69 minutes the transfer claims.
		expect(cell('transfer', 'to-city').minutes).toBe(76);
	});

	it('draws the ride back between leaving the bed and reaching the terminal', () => {
		const back = cell('transfer', 'to-connection-airport');
		expect([back.start.local, back.end.local]).toEqual(['2026-09-17T01:35:00', '2026-09-17T02:38:00']);
		expect(back.minutes).toBe(63);
	});

	it('draws the terminal wait from the moment the traveller gets back to it', () => {
		const wait = porto().segments.find((segment) => segment.kind === 'wait' && segment.start.local.startsWith('2026-09-17'));
		expect(wait?.start.local).toBe('2026-09-17T02:38:00');
		expect(wait?.minutes).toBe(212);
	});

	it('tiles the whole layover with no gap and no overlap', () => {
		// Landing to take-off is 1400 minutes and every cell between the two flights has to
		// account for one of them exactly once.
		const segments = porto().segments;
		const between = segments.slice(segments.findIndex((s) => s.kind === 'flight') + 1, segments.length - 1);
		expect(between.reduce((sum, segment) => sum + segment.minutes, 0)).toBe(1400);
	});
});

/**
 * Issue #399, the origin end of the same reading. The strip drew a 3h 43m ride ending
 * exactly on the check-in deadline and a 2h wait after it, for a traveller the timetable
 * has boarding at 8pm and standing in BCN from 11:36pm.
 */
describe('the strip, over a ride to the airport with a timetable on it', () => {
	function begur() {
		const base = makeItinerary({
			departs: '2026-09-16T05:50:00',
			outboundMinutes: 120,
			stopoverMinutes: 1400,
			onwardMinutes: 270,
			toOriginAirport: {
				mode: 'transit',
				duration: 223 as Duration,
				legs: [{ mode: 'transit', duration: 223 as Duration }],
				transitSchedule: {
					intended: at('2026-09-15T20:00:00'),
					arrival: at('2026-09-15T23:36:00'),
					following: [],
					plannedFor: { time: at('2026-09-16T03:50:00'), arriveBy: true }
				}
			}
		});
		return tripStrip({ ...base, ...deriveItinerary(base) });
	}

	it('draws the ride between boarding and arriving, not backwards off the deadline', () => {
		const ride = begur().segments.find((segment) => segment.kind === 'transfer');
		expect([ride?.start.local, ride?.end.local]).toEqual(['2026-09-15T20:00:00', '2026-09-15T23:36:00']);
		expect(ride?.minutes).toBe(216);
	});

	it('draws the wait from the moment the traveller reaches the terminal', () => {
		const wait = begur().segments.find((segment) => segment.kind === 'wait');
		expect(wait?.start.local).toBe('2026-09-15T23:36:00');
		expect(wait?.minutes).toBe(374);
	});

	it('tiles the origin leg with no gap and no overlap', () => {
		// Boarding to take-off is 9h 50m and the two cells before the outbound flight have to
		// account for one of those minutes exactly once.
		const segments = begur().segments;
		const flightIndex = segments.findIndex((segment) => segment.kind === 'flight');
		const before = segments.slice(0, flightIndex);
		expect(before.reduce((sum, segment) => sum + segment.minutes, 0)).toBe(590);
		for (const [index, segment] of before.entries()) {
			if (index === 0) continue;
			expect(segment.start.local).toBe(before[index - 1]!.end.local);
		}
		expect(before.at(-1)!.end.local).toBe(segments[flightIndex]!.start.local);
	});
});
