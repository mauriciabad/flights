import { describe, expect, it } from 'vitest';
import type { Airport, Duration, FlightOffer, Itinerary, LocalDateTime, Money, Stay, Transfer } from '../domain';
import { segmentStub, stripTargets } from './segment-stub';
import type { StubContext } from './segment-stub';
import { tripStrip } from './trip-strip';

function at(local: string, utcOffsetMinutes = 60, timeZone = 'Europe/London'): LocalDateTime {
	return { local, timeZone, utcOffsetMinutes };
}

const eur = (minorUnits: number): Money => ({ minorUnits, currency: 'EUR' });

function airport(iataCode: string, name: string, cityName: string, latitude = 0, longitude = 0): Airport {
	const country = { isoCode: 'GB', name: 'United Kingdom' };
	return {
		iataCode,
		name,
		coordinates: { latitude, longitude },
		city: { name: cityName, country },
		country,
		sizeClass: 'large'
	};
}

const BVC = airport('BVC', 'Aristides Pereira', 'Boa Vista', 16.14, -22.89);
const LGW = airport('LGW', 'London Gatwick', 'London', 51.15, -0.19);
const PFO = airport('PFO', 'Pafos International', 'Pafos', 34.72, 32.49);

function flight(overrides: Partial<FlightOffer> = {}): FlightOffer {
	return {
		carrier: { iataCode: 'BY', name: 'TUI Airways' },
		flightNumber: 'BY625',
		departureAirport: 'BVC',
		arrivalAirport: 'LGW',
		departure: at('2026-10-06T12:40:00', -60, 'Atlantic/Cape_Verde'),
		arrival: at('2026-10-06T20:30:00', 60),
		duration: 350 as Duration,
		price: eur(12900),
		priceScope: 'per-person',
		baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 1 },
		deepLink: 'https://example.invalid/book',
		...overrides
	};
}

const onward = flight({
	carrier: { iataCode: 'U2', name: 'easyJet' },
	flightNumber: 'U28965',
	departureAirport: 'LGW',
	arrivalAirport: 'PFO',
	departure: at('2026-10-09T15:20:00', 60),
	arrival: at('2026-10-09T22:00:00', 180, 'Asia/Nicosia'),
	duration: 280 as Duration,
	price: eur(8900),
	baggage: { cabinBagsIncluded: 1, checkedBagsIncluded: 0 }
});

const stay: Stay = {
	property: { name: 'Gainsborough Lodge', coordinates: { latitude: 51.17, longitude: -0.16 }, images: [] },
	roomKind: 'private',
	pricePerNight: eur(4400)
};

function walk(minutes: number, overrides: Partial<Transfer> = {}): Transfer {
	return { mode: 'walk', duration: minutes as Duration, legs: [{ mode: 'walk', duration: minutes as Duration }], ...overrides };
}

function itineraryFor(overrides: Partial<Itinerary> = {}): Itinerary {
	const outbound = flight();
	const toHotel = walk(40);
	const toAirport = walk(40);
	const freeStart = at('2026-10-06T21:10:00', 60);
	const freeEnd = at('2026-10-09T12:40:00', 60);
	return {
		originAirport: BVC,
		originWaitingTime: 120 as Duration,
		outboundFlight: outbound,
		transferToHotel: toHotel,
		stay,
		freeTime: { start: freeStart, end: freeEnd, duration: 3690 as Duration },
		nightsInConnection: 3,
		travellers: 1,
		transferToConnectionAirport: toAirport,
		connectionWaitingTime: 120 as Duration,
		onwardFlight: onward,
		destinationAirport: PFO,
		totalPrice: eur(35000),
		times: { inFlight: 630 as Duration, airportWaiting: 240 as Duration, free: 3690 as Duration, total: 4560 as Duration },
		...overrides
	};
}

function contextFor(itinerary: Itinerary, overrides: Partial<StubContext> = {}): StubContext {
	return { itinerary, connectionLabel: 'London', connectionCode: 'LGW', connectionAirport: LGW, ...overrides };
}

/** The stub for the first target of a given kind, which is how the panel picks one too. */
function stubOf(itinerary: Itinerary, kind: string, context = contextFor(itinerary), occurrence = 0) {
	const { segments } = tripStrip(itinerary);
	const target = stripTargets(segments).filter((candidate) => candidate.kind === kind)[occurrence]!;
	return segmentStub(segments, target, context);
}

describe('stripTargets', () => {
	it('folds the whole run of free-time cells into one stopover target, per the owner', () => {
		const { segments } = tripStrip(itineraryFor());
		expect(segments.filter((segment) => segment.kind === 'free').length).toBeGreaterThan(1);
		expect(stripTargets(segments).map((target) => target.kind)).toEqual([
			'wait',
			'flight',
			'transport',
			'stopover',
			'transport',
			'wait',
			'flight'
		]);
	});

	it('spans the stopover target across every free cell, so one tap covers the whole booking', () => {
		const { segments } = tripStrip(itineraryFor());
		const stopover = stripTargets(segments).find((target) => target.kind === 'stopover')!;
		const free = segments.map((segment, index) => (segment.kind === 'free' ? index : -1)).filter((i) => i >= 0);
		expect([stopover.from, stopover.to]).toEqual([free[0], free.at(-1)]);
	});
});

describe('the flight stub', () => {
	it('names the airline and the number, both ends and the elapsed time', () => {
		const stub = stubOf(itineraryFor(), 'flight');
		expect(stub.eyebrow).toBe('FLIGHT');
		expect(stub.title).toBe('TUI Airways BY625');
		expect(stub.day).toBe('Tue, 6 Oct');
		expect(stub.start).toMatchObject({ time: '12:40pm', code: 'BVC', place: 'Boa Vista' });
		expect(stub.end).toMatchObject({ time: '8:30pm', code: 'LGW', place: 'London' });
		expect(stub.duration).toBe('5h 50m');
	});

	it('explains the two clocks when the ends keep different time, which is why 5h 50m reads as 7h 50m', () => {
		const stub = stubOf(itineraryFor(), 'flight');
		expect(stub.footnote).toBe('Clocks are local. London (UTC+1) is 2h ahead of Boa Vista (UTC-1).');
	});

	it('says nothing about offsets when both ends keep the same clock', () => {
		const sameZone = itineraryFor({
			outboundFlight: flight({ departure: at('2026-10-06T12:40:00', 60), arrival: at('2026-10-06T18:30:00', 60) })
		});
		expect(stubOf(sameZone, 'flight').footnote).toBeUndefined();
	});

	it('scales the fare the way build.ts totals it, never printing one adult as the party fare', () => {
		const solo = stubOf(itineraryFor(), 'flight');
		expect(solo.facts).toContainEqual({ label: 'Fare', value: '€129.00' });

		const party = stubOf(itineraryFor({ travellers: 2 }), 'flight');
		expect(party.facts).toContainEqual({ label: 'Fare', value: '€258.00 for 2' });
	});

	it('leaves a party-total fare alone, because multiplying it again would overcount the group', () => {
		const partyTotal = itineraryFor({
			travellers: 2,
			outboundFlight: flight({ priceScope: 'party-total', price: eur(20000) })
		});
		expect(stubOf(partyTotal, 'flight').facts).toContainEqual({ label: 'Fare', value: '€200.00 for 2' });
	});

	it('spells baggage as a yes or a no, never as a bare zero', () => {
		expect(stubOf(itineraryFor(), 'flight').facts).toContainEqual({ label: 'Bags', value: '1 cabin, 1 checked' });
		expect(stubOf(itineraryFor(), 'flight', contextFor(itineraryFor()), 1).facts).toContainEqual({
			label: 'Bags',
			value: '1 cabin, no checked bag'
		});

		const noBags = itineraryFor({
			outboundFlight: flight({ baggage: { cabinBagsIncluded: 0, checkedBagsIncluded: 0 } })
		});
		expect(stubOf(noBags, 'flight').facts).toContainEqual({ label: 'Bags', value: 'none included' });
	});

	it('drops the aircraft row rather than printing a fact nobody gave us', () => {
		expect(stubOf(itineraryFor(), 'flight').facts.map((fact) => fact.label)).not.toContain('Aircraft');
		const known = itineraryFor({ outboundFlight: flight({ aircraft: 'Boeing 787-8' }) });
		expect(stubOf(known, 'flight').facts).toContainEqual({ label: 'Aircraft', value: 'Boeing 787-8' });
	});

	it('warns about a technical stop, because it sits inside the duration', () => {
		const withStop = itineraryFor({
			outboundFlight: flight({
				technicalStops: [
					{
						airport: 'SID',
						arrival: at('2026-10-06T13:35:00', -60),
						departure: at('2026-10-06T14:30:00', -60),
						groundTime: 55 as Duration
					}
				]
			})
		});
		expect(stubOf(withStop, 'flight').notes).toContainEqual({
			text: 'Stops in SID for 55m, everyone stays on board.',
			tone: 'warning'
		});
	});

	it('says an avoided airline in words, since the greyed-out treatment is colour alone', () => {
		const itinerary = itineraryFor();
		const stub = stubOf(itinerary, 'flight', contextFor(itinerary, { deprioritized: true }));
		expect(stub.notes).toContainEqual({ text: 'An airline you asked to avoid.', tone: 'plain' });
	});

	it('stamps the arrival with its own date when the flight lands on another day', () => {
		const overnight = itineraryFor({
			outboundFlight: flight({
				departure: at('2026-10-06T23:50:00', 60),
				arrival: at('2026-10-07T06:10:00', 60),
				duration: 380 as Duration
			})
		});
		expect(stubOf(overnight, 'flight').end).toMatchObject({ date: 'Wed, 7 Oct', plusDays: 1 });
	});
});

describe('the airport wait stub', () => {
	it('names the airport and what the wait ends in', () => {
		const stub = stubOf(itineraryFor(), 'wait', contextFor(itineraryFor()), 1);
		expect(stub.eyebrow).toBe('AIRPORT WAIT');
		expect(stub.title).toBe('London Gatwick LGW');
		expect(stub.facts).toContainEqual({ label: 'Before', value: 'easyJet U28965 to Pafos, 3:20pm' });
	});

	it('says the wait is the traveller\'s own setting, not a measured queue', () => {
		const stub = stubOf(itineraryFor(), 'wait');
		expect(stub.footnote).toBe(
			'Your own buffer, not a measured queue. 2h is the setting for this airport, and Show details is where you change it.'
		);
	});

	it('leaves the end clock unstamped, since a wait happens in one place', () => {
		const stub = stubOf(itineraryFor(), 'wait');
		expect(stub.start).toMatchObject({ code: 'BVC', place: 'Boa Vista' });
		expect(stub.end.code).toBeUndefined();
		expect(stub.end.place).toBeUndefined();
	});

	it('falls back to the bare code before the page has resolved the airport record', () => {
		const itinerary = itineraryFor();
		const stub = stubOf(itinerary, 'wait', contextFor(itinerary, { connectionAirport: undefined }), 1);
		expect(stub.title).toBe('London LGW');
	});
});

describe('the transport stub', () => {
	it('names the walk and where it goes, and prints no fare as the fact it is', () => {
		const stub = stubOf(itineraryFor(), 'transport');
		expect(stub.eyebrow).toBe('TRANSPORT');
		expect(stub.title).toBe('Walk to Gainsborough Lodge');
		expect(stub.facts).toContainEqual({ label: 'Fare', value: 'No fare', unknown: false });
	});

	it('marks a ride nobody quoted as unknown rather than free', () => {
		const bus = itineraryFor({ transferToHotel: { mode: 'transit', duration: 25 as Duration, legs: [] } });
		expect(stubOf(bus, 'transport').facts).toContainEqual({
			label: 'Fare',
			value: 'Price not available',
			unknown: true
		});
	});

	it('prints a quoted fare through the app\'s one money edge', () => {
		const taxi = itineraryFor({
			transferToHotel: { mode: 'taxi', duration: 20 as Duration, legs: [], price: eur(3250) }
		});
		expect(stubOf(taxi, 'transport').facts).toContainEqual({
			label: 'Fare',
			value: '€32.50',
			unknown: false
		});
	});

	it('labels a great-circle figure as a straight line, and a routed one as the road it is', () => {
		const straight = stubOf(itineraryFor(), 'transport').facts.find((fact) => fact.label === 'Distance');
		expect(straight?.value).toMatch(/straight line$/);

		const routed = itineraryFor({
			transferToHotel: walk(40, {
				path: [
					{ latitude: 51.15, longitude: -0.19 },
					{ latitude: 51.16, longitude: -0.17 },
					{ latitude: 51.17, longitude: -0.16 }
				]
			})
		});
		const road = stubOf(routed, 'transport').facts.find((fact) => fact.label === 'Distance');
		expect(road?.value).not.toMatch(/straight line/);
		expect(road?.value).toMatch(/km$/);
	});

	it('answers the last-bus question from the schedule, never claiming more than was observed', () => {
		const missed = itineraryFor({
			transferToHotel: {
				mode: 'transit',
				duration: 25 as Duration,
				legs: [],
				transitSchedule: {
					intended: at('2026-10-06T20:45:00', 60),
					following: [],
					plannedFor: { time: at('2026-10-06T20:40:00', 60), arriveBy: false }
				}
			}
		});
		expect(stubOf(missed, 'transport').facts).toContainEqual({
			label: 'If you miss it',
			value: 'Nothing later was found',
			unknown: true
		});

		const later = itineraryFor({
			transferToHotel: {
				mode: 'transit',
				duration: 25 as Duration,
				legs: [],
				transitSchedule: {
					intended: at('2026-10-06T20:45:00', 60),
					following: [at('2026-10-06T21:35:00', 60)],
					plannedFor: { time: at('2026-10-06T20:40:00', 60), arriveBy: false }
				}
			}
		});
		expect(stubOf(later, 'transport').facts).toContainEqual({
			label: 'If you miss it',
			value: '9:35pm, 50m later'
		});
	});

	it('says the city when no bed was priced, rather than naming a property it does not have', () => {
		const noBed = itineraryFor({ stay: undefined });
		expect(stubOf(noBed, 'transport').title).toBe('Walk into London');
	});
});

describe('the stopover stub', () => {
	it('leads with the nights and hands its facts to StopoverBlock', () => {
		const stub = stubOf(itineraryFor(), 'stopover');
		expect(stub.eyebrow).toBe('STOPOVER');
		expect(stub.title).toBe('3 nights in London');
		expect(stub.duration).toBe('2d 14h free');
		expect(stub.rendersStopoverBlock).toBe(true);
	});

	it('runs from the first free reading to the last, which is the window the block prints', () => {
		const itinerary = itineraryFor();
		const stub = stubOf(itinerary, 'stopover');
		expect(stub.start.time).toBe('9:10pm');
		expect(stub.end).toMatchObject({ time: '12:40pm', date: 'Fri, 9 Oct' });
	});

	it('carries no plus-day stamp, since spanning days is the thing being sold', () => {
		expect(stubOf(itineraryFor(), 'stopover').end.plusDays).toBeUndefined();
	});

	it('puts the bed on the map, which is issue #219\'s whole complaint', () => {
		const stub = stubOf(itineraryFor(), 'stopover');
		expect(stub.facts.map((fact) => fact.label)).toContain('From LGW');
		expect(stub.facts.find((fact) => fact.label === 'From LGW')?.value).toMatch(/straight line$/);
	});

	it('drops the distance rather than guessing when the airport record has not resolved', () => {
		const itinerary = itineraryFor();
		const stub = stubOf(itinerary, 'stopover', contextFor(itinerary, { connectionAirport: undefined }));
		expect(stub.facts).toEqual([]);
	});

	it('calls a same-day connection a day stopover rather than zero nights', () => {
		const sameDay = itineraryFor({
			nightsInConnection: 0,
			freeTime: { start: at('2026-10-06T21:10:00', 60), end: at('2026-10-06T23:40:00', 60), duration: 150 as Duration }
		});
		const stub = stubOf(sameDay, 'stopover');
		expect(stub.title).toBe('Day stopover in London');
		expect(stub.duration).toBe('2h 30m free');
	});
});
