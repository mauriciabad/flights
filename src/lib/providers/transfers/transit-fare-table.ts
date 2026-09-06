import type {
	FareEstimate,
	FareParty,
	FareRange,
	IataAirportCode,
	IsoCountryCode,
	IsoCurrencyCode
} from '../../domain';
import { inTravellerCurrency } from './fare-currency';

/**
 * What a public-transport ride between an airport and its city costs, from a table of
 * published tariffs, for the legs where no provider quotes one. Issue #407.
 *
 * The owner: "the price on the public transport is missing. there should be an estimate."
 * Transitous answers a timetable, not a ticket price, so every transit leg reached the card
 * with an empty `Transfer.price` and the total disclaimed the whole ride as unpriced.
 * `stays/stopover-cost.ts` says at length what that cost the ranking: with no transit fare
 * to weigh, it has to bill a metro ride at a taxi's per-kilometre rate and calls Gatwick to
 * central London about 68 against a real 12-pound ticket.
 *
 * Never a quote. `estimateTransitFare` answers with a `FareRange` or a refusal, both from
 * `domain/fare.ts`, which exists so nothing can assign one to a `Transfer.price` by
 * accident. AGENTS.md, "When the data is missing": "never present an estimate as a fact."
 *
 * ## Why this is keyed by airport where the taxi card is keyed by country
 *
 * `taxi-rate-table.ts` is a rate per kilometre, and a kilometre costs roughly the same
 * across one country's cities. A transit fare is not a function of distance at all: it is a
 * ticket, and which ticket depends on where you are standing.
 *
 * The obvious next step is a table per city, and that is one step short. Every transit leg
 * this app ever asks about has exactly one airport at one end (`search/transit-schedule.ts`
 * plans four legs and all four run to or from a runway), and for an airport journey the
 * airport link is what dominates the fare rather than the city's ordinary single. London is
 * the demonstration: a Stansted Express advance is £9.90, an Elizabeth line journey from
 * Heathrow into Zone 1 is £13.90, and the Luton DART alone is £4.90. Three fares, one city,
 * no useful average. So the key is the airport.
 *
 * ## What each card is allowed to say
 *
 * The rule every entry below is held to, and the reason coverage is thin:
 *
 * **The low bound must be a cited fare for the cheapest published public-transport option
 * at that airport, and the high bound a cited fare for the dearest.** Where the two are one
 * product, the bounds are equal and the citation says the network sells one fare for this
 * journey, which for Berlin and Lisbon is simply true.
 *
 * An airport whose cheapest option's fare could not be read gets no card at all, and that
 * refusal is the whole reason to trust the rest. `FALLBACK_TAXI_RATE_CARD` next door has
 * the argument in full: "a band that is narrower than the evidence it cites is just a
 * fourth invented card". Pricing Rome's airport at the €14 Leonardo Express while the FL1
 * regional train does the same trip for less would be exactly that, so Rome is not here.
 * Neither are Stansted, Heathrow, Luton, Dublin, Malpensa or Vienna, each for the same
 * reason and each named below or in issue #407 with the fare that was missing. Gatwick is
 * out for a different reason, which has its own section.
 *
 * ## What made Britain readable, after a pass that decided it was not
 *
 * `docs/ACCEPTANCE.md`'s own trip connects through Birmingham, Gatwick and Manchester, and
 * issue #407 shipped with none of the three. Its measurement was real and its conclusion was
 * a step too wide: six rail operator sites answered 403, tfgm.com answered 202, and
 * gatwickexpress.com served 162 KB whose only fare was a £2 child ticket, so the anytime
 * rail single looked unreadable everywhere in Britain.
 *
 * Two things were wrong with that, and issue #415 is the second pass. The 202 from tfgm.com
 * is a bot challenge that renders the page anyway, so read in a browser rather than judged
 * by its status code it carries TfGM's whole fare table. And a train operating company is
 * not the only publisher of a rail fare. National Rail Enquiries, the operators' own
 * enquiry service, renders the walk-up ticket list for a named journey as ordinary
 * server-rendered HTML at
 * `ojp.nationalrail.co.uk/service/timesandfares/FROM/TO/DDMMYY/HHMM/dep`, ticket names
 * included, and answers a Chrome User-Agent with a 200. Every Anytime Day Single below came
 * from there. `tools/probe-uk-transit-fares.mjs` re-reads all of it and prints what it found
 * beside what is written here, because a citation nobody can re-run is a claim rather than
 * a source.
 *
 * The rule did not move to let Birmingham and Manchester in. Each carries a cited fare for
 * its cheapest published option and a cited fare for its dearest, which is what issue #415
 * hoped for and why `domain/fare.ts` did not need the one-sided bound that issue proposed as
 * its fallback.
 *
 * ## Gatwick is readable now and still not here, for a new reason
 *
 * Both its bounds came out: National Express service 025 runs London Victoria to Gatwick
 * from £6.00 one way (nationalexpress.com, read 2026-09-06), and the Gatwick Express Anytime
 * single is £24.10, the £21.30 Anytime Day Single carrying "Not valid for travel on Gatwick
 * Express services" and £24.10 being what the non-stop service those conditions exclude
 * sells (National Rail Enquiries, read 2026-09-06). By the rule above that is a card.
 *
 * What stops it is the assumption every other card rests on without saying so: **a flat band
 * may be applied to any journey inside `ratedUpToKm` only where the fare does not depend on
 * the distance.** Barcelona sells one integrated single whether you ride two stops or twelve,
 * so stretching it over a shorter journey costs nothing. Gatwick sells a 40 km ticket into
 * central London, and the stay this app pairs with a Gatwick stopover is usually not in
 * London at all. That is deliberate and it is the owner's own issue #204: he asked for the
 * hostels in Horley, thirty minutes on foot from the terminal, and `docs/PROVIDERS.md` has
 * the adapter now reaching them. On the acceptance trip the stay came back 3.2 km from the
 * runway with Transitous planning bus 100 to reach it (`tools/probe-transit-legs.mjs`,
 * 2026-09-06). Pricing that hop at £6.00 to £24.10 would overstate the cheapest way to make
 * it several times over, which is the Rome mistake in a British accent. A card that fits
 * Gatwick needs a floor distance as well as a ceiling, and that is a change to this module's
 * shape rather than another row in it. Issue #421 carries both fares so the next pass does
 * not read them again, and Stansted, Heathrow and Luton sit behind the same change.
 *
 * Three more British airports fail on narrower points than "the fare is unreadable".
 * Stansted's cheap end is National Express's £7.00 lead fare, and the page carrying it says
 * those fares are correct for travel until 13.09.2026, a week from this reading, so it would
 * be stale before most travellers met it. Heathrow's cheapest option is the Piccadilly line,
 * whose single fare TfL publishes only through a fare-finder tool this pass could not drive.
 * Luton's rail journey is a DART ride from the terminal plus a separate fare onward from
 * Luton Airport Parkway, and only the second half of that (£19.20 to St Pancras) was read.
 *
 * Every figure below was read on **2026-09-06**, on the operator's own page or, for the
 * British rail fares, on the operators' own National Rail Enquiries, and each citation names
 * the operator, the product and the page. A fare with no source in it is worse than an empty
 * row, because the next reader cannot tell a researched number from a remembered one.
 *
 * ## The party multiplies
 *
 * A meter charges the car and a turnstile charges the head, which is the distinction
 * `domain/fare.ts`'s `FareParty` was given a `basis` for. Every card here is per person, so
 * four travellers pay four fares, and `FareRange.lowMinorUnits` carries the party's total
 * exactly as the taxi card's does. Issue #344 made that mistake impossible to make
 * silently; this is the mode it was waiting for.
 */

interface TransitFareCard {
	/** The city a screen would name for this airport. Not read from `Airport.city`, which
	 * carries the municipality the runway sits in: Athens' airport is in Spata-Artemida and
	 * Linate is in Segrate, and neither is the city whose tariff this is. */
	city: string;
	countryCode: IsoCountryCode;
	currency: IsoCurrencyCode;
	/**
	 * One adult, one journey between this airport and the city centre, minor units,
	 * `[cheapest published option, dearest published option]`.
	 */
	journeyMinorUnits: readonly [number, number];
	/**
	 * What one more vehicle costs, when the airport product does not carry the traveller
	 * onward across the city network.
	 *
	 * Absent is the common case and it is a fact about the network rather than a gap: a
	 * Prague 90-minute ticket, a Berlin ABC ticket and a Barcelona integrated single all
	 * cover the changes inside one journey, so the leg count is not an input to the fare.
	 * Present means the network sells a ride rather than a journey, and then the boarding
	 * count Transitous actually returned is what the arithmetic multiplies. Amsterdam and
	 * Budapest are the two here that work that way, for different reasons their citations
	 * give.
	 *
	 * Birmingham is the exception to that reading and its citation says so: its network sells
	 * a ride, so it has earned an onward fare, and it does not get one because the boarding
	 * count it would multiply is wrong. Transitous returns the free Air-Rail Link as a ridden
	 * leg, so a card charging per boarding would bill a fare for a monorail the airport gives
	 * away. Where a field like this can be absent for two different reasons, the citation has
	 * to say which one, because the arithmetic cannot.
	 */
	onwardMinorUnits?: readonly [number, number];
	/** Straight-line kilometres from the runway to the city centre this card prices a
	 * journey into, measured against `data/city-centres.generated.json` on 2026-09-06.
	 * `ratedUpToKm` below is derived from it rather than written down twice. */
	centreKm: number;
	/** The operator, the product and the page each bound came from, and what this card does
	 * NOT price. */
	citation: string;
}

/**
 * How far past the city centre a card still describes the journey.
 *
 * 15 km, and the number is arguable, so here is the argument. Every card below prices a
 * journey into the centre, and a bed is not at the centre. A bed 15 km beyond it is still
 * inside the fare area each of these tickets covers: Berlin's ABC zone reaches about 20 km
 * past Mitte, Paris zones 1 to 5 about 25 km past Châtelet, and Barcelona's zone 1 about
 * 15 km past Plaça Catalunya. Past that a journey is buying a second zone this table has
 * not read a price for, and `estimateTransitFare` refuses rather than stretching a ticket
 * over ground it was not sold for. Same shape and the same reasoning as
 * `MAX_RATED_TAXI_DISTANCE_KM`, which refuses a 94.9 km motorway run off a card
 * back-calculated from a 5.1 km city ride.
 */
export const TRANSIT_FARE_SLACK_KM = 15;

/** The longest journey `card` describes: to the centre, rounded up to the next 5 km so the
 * measurement's own precision is not implied, plus the slack above. Derived rather than
 * stored, so a card cannot claim a reach its measured distance does not support. */
export function ratedUpToKm(card: { centreKm: number }): number {
	return Math.ceil(card.centreKm / 5) * 5 + TRANSIT_FARE_SLACK_KM;
}

/**
 * The airports this app can price a public-transport journey at, and nothing else.
 *
 * Read the module header before adding one. The bar is a cited fare for the cheapest
 * option, not a plausible figure, and an airport is better absent than approximated: a leg
 * with no card here comes back with no estimate and the picker already says "Price not
 * available", which is the app telling the truth.
 */
export const TRANSIT_FARE_TABLE: Readonly<Record<IataAirportCode, TransitFareCard>> = {
	AMS: {
		city: 'Amsterdam',
		countryCode: 'NL',
		currency: 'EUR',
		journeyMinorUnits: [550, 550],
		onwardMinorUnits: [340, 340],
		centreKm: 11.2,
		citation:
			'NS, the Dutch national rail operator, prices a Schiphol Airport to Amsterdam e-ticket ' +
			'from €5.50 on its own route page (ns.nl, read 2026-09-06). That ticket ends at the ' +
			'station, so a change onto the city network costs a GVB 1-hour ticket at €3.40 ' +
			'(gvb.nl/tarieven, read 2026-09-06) for each further vehicle. The airport coach (bus ' +
			'397) is dearer and its fare was not read, so this card does not price it.'
	},
	ATH: {
		city: 'Athens',
		countryCode: 'GR',
		currency: 'EUR',
		journeyMinorUnits: [550, 900],
		centreKm: 19.0,
		citation:
			"OASA's own fare list (oasa.gr, read 2026-09-06) prices both published airport " +
			'services: the Airport Express bus at €5.50 and the Metro line 3 airport ticket at ' +
			'€9.00. Each is valid across the OASA network for 90 minutes, so a change onto a bus ' +
			'or the tram at the other end costs nothing more.'
	},
	BCN: {
		city: 'Barcelona',
		countryCode: 'ES',
		currency: 'EUR',
		journeyMinorUnits: [290, 590],
		centreKm: 12.2,
		citation:
			"TMB's own 2026 fare table (tmb.cat, read 2026-09-06, fares effective 15 January 2026): " +
			'an integrated 1-zone single is €2.90 and the Bitllet Aeroport is €5.90. The €2.90 ' +
			'single carries bus 46 and the R2 Nord train; only the L9 Sud metro at Aeroport T1 and ' +
			'T2 needs the €5.90 ticket. Both are one integrated journey, changes included.'
	},
	BER: {
		city: 'Berlin',
		countryCode: 'DE',
		currency: 'EUR',
		journeyMinorUnits: [500, 500],
		centreKm: 19.1,
		citation:
			"BVG's own single-ticket page (bvg.de, read 2026-09-06): fare zone AB is €4.00 and ABC " +
			'is €5.00, valid 120 minutes with changes permitted. Berlin Brandenburg sits in zone C, ' +
			'so the S-Bahn, the FEX, the regional trains and the buses into the city all take the ' +
			'same ABC ticket. Berlin really does sell one fare for this journey, which is why the ' +
			'two bounds are the same number.'
	},
	BHX: {
		city: 'Birmingham',
		countryCode: 'GB',
		currency: 'GBP',
		journeyMinorUnits: [300, 500],
		centreKm: 10.7,
		citation:
			'National Express West Midlands prices an nBus adult single trip at £3.00 on its own ' +
			'fares page (nxbus.co.uk/west-midlands/tickets-prices/single-trips-day-tickets, read ' +
			'2026-09-06), and the airport says the X1 and X12 call at stops K and L on the terminal ' +
			'forecourt (birminghamairport.co.uk, read 2026-09-06). The dear end is rail. The ' +
			'Air-Rail Link to Birmingham International is free, "a complimentary service" in the ' +
			"airport's own words, and the Anytime Day Single from there to Birmingham New Street is " +
			'£5.00 (National Rail Enquiries journey planner, read 2026-09-06). The leg count does ' +
			'not enter this fare, and here that is a compromise rather than a fact about the ' +
			'network. An nBus single buys one bus journey, so a change onto a second bus really is ' +
			'another £3.00. But Transitous returns the free Air-Rail Link as a ridden leg (mode ' +
			'OTHER, route AIR, measured on the acceptance trip 2026-09-06), so charging per ' +
			'boarding would bill £3.00 for a monorail the airport gives away. Missing a change is ' +
			'the smaller error of the two, and the West Midlands Metro tram, the other change a ' +
			'traveller might make, publishes its singles only through a fare finder anyway.'
	},
	BUD: {
		city: 'Budapest',
		countryCode: 'HU',
		currency: 'HUF',
		journeyMinorUnits: [50000, 250000],
		onwardMinorUnits: [50000, 50000],
		centreKm: 18.3,
		citation:
			"BKK's own price list (bkk.hu, read 2026-09-06): a single ticket is 500 Ft and the " +
			'airport shuttle bus single is 2,500 Ft. A BKK single buys one vehicle rather than one ' +
			'journey, so each further vehicle is another 500 Ft at either end of the band: bus 200E ' +
			'plus the M3 metro is two singles, and the 100E airport express plus a metro is the ' +
			'shuttle ticket plus one.'
	},
	CDG: {
		city: 'Paris',
		countryCode: 'FR',
		currency: 'EUR',
		journeyMinorUnits: [205, 1400],
		centreKm: 22.9,
		citation:
			"Île-de-France Mobilités' own 2026 fare table (iledefrance-mobilites.fr, read " +
			'2026-09-06, rates applicable as of 1 January 2026): the Paris Region ↔ Airports single ' +
			'is €14.00 and the ordinary Bus-Tram single is €2.05. IDFM says the airport ticket ' +
			'covers Roissy-CDG by RER B and is rail only. Its words: "your journey can only be made by ' +
			'metro, RER or train in zones 1 to 5". So the bus lines that also serve the airport are not ' +
			'on it. That they take the €2.05 bus ticket instead is inferred from the airport ' +
			"ticket's stated scope rather than read, which is why the band is this wide."
	},
	LIN: {
		city: 'Milan',
		countryCode: 'IT',
		currency: 'EUR',
		journeyMinorUnits: [220, 220],
		centreKm: 7.2,
		citation:
			"ATM's own English ticket page (atm.it, read 2026-09-06): the Milan urban ticket is " +
			'€2.20. Linate is inside the urban area, so bus 73 and metro M4 into the centre both ' +
			'take it, and it carries changes for 90 minutes. Milan Malpensa is a different fare ' +
			'and is deliberately not in this table.'
	},
	LIS: {
		city: 'Lisbon',
		countryCode: 'PT',
		currency: 'EUR',
		journeyMinorUnits: [190, 190],
		centreKm: 6.4,
		citation:
			"Metropolitano de Lisboa's own \"New fares 2026\" notice (metrolisboa.pt, read " +
			'2026-09-06): a Carris/Metro ticket is €1.90, valid for one journey across the whole ' +
			'Carris and Metro network for an hour after validation. Aeroporto is a station on that ' +
			'network, so the airport journey and any change on it are one €1.90 ticket.'
	},
	MAD: {
		city: 'Madrid',
		countryCode: 'ES',
		currency: 'EUR',
		journeyMinorUnits: [450, 500],
		centreKm: 14.0,
		citation:
			"Metro de Madrid's own airport fares page (metromadrid.es, read 2026-09-06): a Zone A " +
			'single is €1.50 to €2.00 depending on how many stations you pass, and every journey to ' +
			'or from the airport terminals adds a €3.00 airport supplement per passenger. The ' +
			'supplement is charged once and the metro journey it attaches to carries changes, so ' +
			'€4.50 to €5.00 is the whole fare.'
	},
	MAN: {
		city: 'Manchester',
		countryCode: 'GB',
		currency: 'GBP',
		journeyMinorUnits: [200, 620],
		centreKm: 14.9,
		citation:
			"TfGM's own bus ticket page (tfgm.com/tickets-and-passes/bus-tickets, read 2026-09-06) " +
			"prices the Bee Bus single 'hopper' at £2.00 for adults, and the airport names 43, 103, " +
			'130, 199, 248, 288, 313 and 368 as the Bee Network services linking it to the city ' +
			'centre (manchesterairport.co.uk, read 2026-09-06). The dear end is the Anytime Day ' +
			'Single from Manchester Airport to Manchester Piccadilly at £6.20 (National Rail ' +
			'Enquiries journey planner, read 2026-09-06). Metrolink sits between the two at £4.60, ' +
			"TfGM's all-zones adult single, because its own fare-zone page puts the airport in zone " +
			'4 and the city centre in zone 1 (tfgm.com, read 2026-09-06). The leg count is not an ' +
			'input to any of the three: the hopper carries further Bee Network buses for 60 minutes, ' +
			'a Metrolink zone ticket covers the whole zonal journey, and TfGM says a train ticket to ' +
			'MANCHESTER CTLZ is valid on Metrolink in zone 1.'
	},
	ORY: {
		city: 'Paris',
		countryCode: 'FR',
		currency: 'EUR',
		journeyMinorUnits: [205, 1400],
		centreKm: 13.8,
		citation:
			"Île-de-France Mobilités' own 2026 fare table (iledefrance-mobilites.fr, read " +
			'2026-09-06, rates applicable as of 1 January 2026): the Paris Region ↔ Airports single ' +
			'is €14.00 and covers Orly by metro line 14 or Orlyval; the ordinary Bus-Tram single is ' +
			'€2.05. IDFM says the airport ticket is rail only, so the bus and tram routes that also ' +
			'reach Orly are not on it. That they take the €2.05 ticket instead is inferred from the ' +
			"airport ticket's stated scope rather than read, which is why the band is this wide."
	},
	PRG: {
		city: 'Prague',
		countryCode: 'CZ',
		currency: 'CZK',
		journeyMinorUnits: [4600, 5000],
		centreKm: 11.6,
		citation:
			"Dopravní podnik hlavního města Prahy's own price list (dpp.cz, read 2026-09-06): a " +
			'90-minute ticket is 46 Kč in the PID Lítačka app and 50 Kč on paper, valid on every ' +
			'mode with unlimited changes. Václav Havel Airport is inside the Prague zones, so bus ' +
			'119 plus the metro is one such ticket.'
	},
	WAW: {
		city: 'Warsaw',
		countryCode: 'PL',
		currency: 'PLN',
		journeyMinorUnits: [440, 440],
		centreKm: 7.8,
		citation:
			"Warszawski Transport Publiczny's own tariff page (wtp.waw.pl, read 2026-09-06): the " +
			'75-minute transfer ticket for zone 1 is 4.40 zł at the standard rate, and a 20-minute ' +
			'ticket is 3.40 zł. Chopin Airport is in zone 1, so the 175 and 188 buses and the S2 ' +
			'and S3 trains into the centre all take the 75-minute ticket, changes included.'
	}
};

/**
 * What a party pays for a journey one card prices, and what that is each. Issue #407.
 *
 * `undefined` for a lone traveller, where the ticket's price, the party's price and the
 * head's share are one number and printing it three times says nothing. The same rule
 * `partyShare` in `taxi-rate-table.ts` follows, pointed the other way: a taxi divides
 * between heads and a ticket multiplies by them.
 */
function partyShare(
	perPersonLowMinorUnits: number,
	perPersonHighMinorUnits: number,
	people: number
): FareParty | undefined {
	if (people <= 1) return undefined;
	return {
		basis: 'per-person',
		people,
		perPersonLowMinorUnits,
		perPersonHighMinorUnits
	};
}

/**
 * Turns one airport, one journey length and one boarding count into a transit fare range,
 * or into a refusal, or into nothing at all.
 *
 * Three answers, and the difference between the last two is the point. A `FareRange` is a
 * cited guess. A `FareBeyondRatedRange` is this table saying the journey has left the fare
 * area its ticket was sold for, which a screen can put in words. `undefined` is no card for
 * this airport, which reaches a reader as `groundFare`'s existing `'unquoted'` and the
 * words "Price not available", the app's oldest and most honest answer, and the right one
 * for the 97% of connection airports nobody has read a tariff for.
 *
 * Pure and synchronous, the same property `estimateTaxiFare` has and for the same reason:
 * it is arithmetic over a static table, so nothing here needs caching or a network. That
 * also keeps it out of the Transitous response cache, which holds a timetable and must not
 * start holding a fare computed for one search's currency and party.
 *
 * `boardings` is how many vehicles the journey Transitous returned actually rides, walking
 * legs excluded. It changes the answer only where a card carries `onwardMinorUnits`, which
 * is where the network sells a ride rather than a journey.
 *
 * `straightLineKm` rather than a routed distance because a transit leg has no geometry
 * (Transitous returns a schedule, not a path). It is a lower bound on the real journey, so
 * the refusal below fires less often than a routed measurement would, which is the
 * direction every bound in this app errs in: `SLOWEST_USEFUL_TRANSIT_KM_PER_HOUR` makes the
 * same choice for the same reason.
 */
export function estimateTransitFare(
	airportCode: IataAirportCode,
	straightLineKm: number,
	boardings: number,
	displayCurrency?: IsoCurrencyCode,
	travellers?: number
): FareEstimate | undefined {
	if (!(straightLineKm >= 0)) {
		throw new Error(`estimateTransitFare requires a non-negative distance, got ${straightLineKm}`);
	}

	const card = TRANSIT_FARE_TABLE[airportCode];
	if (!card) return undefined;

	const ratedUpTo = ratedUpToKm(card);
	if (straightLineKm > ratedUpTo) {
		return {
			kind: 'out-of-range',
			distanceKm: straightLineKm,
			ratedUpToKm: ratedUpTo,
			countryCode: card.countryCode,
			citation: card.citation
		};
	}

	const rides = Math.max(1, Math.floor(boardings));
	const extraBoardings = card.onwardMinorUnits ? rides - 1 : 0;
	const onward = card.onwardMinorUnits ?? [0, 0];
	const perPersonLowMinorUnits = card.journeyMinorUnits[0] + extraBoardings * onward[0];
	const perPersonHighMinorUnits = card.journeyMinorUnits[1] + extraBoardings * onward[1];

	const people = Math.max(1, Math.floor(travellers ?? 1));
	const party = partyShare(perPersonLowMinorUnits, perPersonHighMinorUnits, people);

	return inTravellerCurrency(
		{
			kind: 'estimate',
			currency: card.currency,
			lowMinorUnits: perPersonLowMinorUnits * people,
			highMinorUnits: perPersonHighMinorUnits * people,
			countryCode: card.countryCode,
			// Always `'country'`, never `'fallback'`. The word is `taxi-rate-table.ts`'s, where
			// it separates a read tariff from a generic cross-country band standing in for one.
			// This table has no such band: an airport is either in it with a citation or it is
			// not in it at all, so every range it produces is the dedicated kind.
			rateSource: 'country',
			citation: card.citation,
			...(party ? { party } : {})
		} satisfies FareRange,
		displayCurrency
	);
}

/** How many vehicles a transit journey rides, which is what `estimateTransitFare` prices
 * where a network sells a ride rather than a journey. Walking legs are not boardings: the
 * walk to the stop and the walk off at the other end are free, which `domain/transfer.ts`
 * is clear is a fact rather than a gap. A journey whose legs are all walks still counts as
 * one boarding, because a transit `Transfer` that rides nothing is a mapping fault rather
 * than a free ride. */
export function countTransitBoardings(legs: readonly { mode: string }[]): number {
	return Math.max(1, legs.filter((leg) => leg.mode !== 'walk').length);
}
