import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../cache";
import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from "../domain";
import type { Coordinates, Duration, Transfer } from "../domain";
import type {
  ProviderId,
  ProviderResult,
  ProviderSource,
  TransferProvider,
  TransferSearchQuery,
} from "../providers/types";
import { createOsrmTransferProvider } from "../providers/transfers/osrm";
import { routeToProperty } from "./route-to-property";

const GATWICK: Coordinates = { latitude: 51.1537, longitude: -0.1821 };
/** The Gatwick White House Hotel, 2.8 km out — issue #267's own acceptance property. */
const WHITE_HOUSE: Coordinates = { latitude: 51.1614, longitude: -0.1637 };

/** A bed 12 km up the road, far enough that `walkIsWorthRouting` never asks for a foot
 * route, which leaves the taxi as `pickBestTransfer`'s answer. That distance is what makes
 * issue #356 visible at all. A walk is free and needs no rate card, so a missing fare only
 * shows on a bed you have to ride to. */
const FAR_BED: Coordinates = { latitude: 51.2617, longitude: -0.1821 };

/** What the app actually ships (`domain/waiting-time.ts`): 15 minutes to get off the
 * plane and onto the street, 30 at a large airport. Gatwick is large. Asserting against
 * the real table rather than a fixture one, because the point of this test is that a bed
 * routed here lands at the same minute as the same bed routed by the pipeline. */
const RULES = DEFAULT_LANDING_TO_TRANSPORT_RULES;

function source(id: string): ProviderSource {
  return {
    providerId: id as ProviderId,
    fetchedAt: "2026-10-06T12:00:00.000Z",
  };
}

function transfer(mode: Transfer["mode"], minutes: number): Transfer {
  return {
    mode,
    duration: minutes as Duration,
    legs: [{ mode, duration: minutes as Duration }],
  };
}

function fixtureProvider(
  answer: (query: TransferSearchQuery) => ProviderResult<Transfer[]>,
  id = "osrm-fixture",
): TransferProvider {
  return {
    kind: "transfer",
    id: id as ProviderId,
    label: `Fixture transfers (${id})`,
    needsKey: false,
    keyFields: [],
    modes: ["walk", "drive", "taxi"],
    async healthCheck() {
      return { ok: true, data: {}, source: source(id), requestsUsed: 0 };
    },
    async searchTransfers(query: TransferSearchQuery) {
      return answer(query);
    },
  };
}

function inputWith(providers: readonly TransferProvider[]) {
  return {
    connectionCoordinates: GATWICK,
    propertyCoordinates: WHITE_HOUSE,
    transferProviders: providers,
    keys: {},
    signal: new AbortController().signal,
    landingToTransportRules: RULES,
    connectionAirportSize: "large" as const,
    connectionCountryCode: "GB" as const,
    displayCurrency: "EUR" as const,
    travellers: 1,
    record: () => {},
  };
}

describe("routing to a property the search never picked (issue #267)", () => {
  it("asks about both directions, so the bed has a journey there and a journey back", async () => {
    const asked: Array<[Coordinates, Coordinates]> = [];
    const provider = fixtureProvider((query) => {
      asked.push([query.from, query.to]);
      return {
        ok: true,
        data: [transfer("drive", 10)],
        source: source("osrm-fixture"),
        requestsUsed: 1,
      };
    });

    const routing = await routeToProperty(inputWith([provider]));

    expect(routing.kind).toBe("routed");
    expect(asked).toEqual([
      [GATWICK, WHITE_HOUSE],
      [WHITE_HOUSE, GATWICK],
    ]);
  });

  it("pads the leg that starts at a runway and leaves the one that ends at a gate alone", async () => {
    // The whole reason the rules are threaded in rather than defaulted here: a bed routed
    // by this function and the same bed routed by `fetchConnectionResources` have to land
    // the traveller at the same minute, or the free-time window depends on which code path
    // produced it.
    const provider = fixtureProvider(() => ({
      ok: true,
      data: [transfer("drive", 10)],
      source: source("osrm-fixture"),
      requestsUsed: 1,
    }));

    const routing = await routeToProperty(inputWith([provider]));

    if (routing.kind !== "routed") throw new Error(`expected routed, got ${routing.kind}`);
    expect(routing.transferToHotel.duration).toBe(40);
    expect(routing.transferToConnectionAirport.duration).toBe(10);
  });

  it("never hands back half a journey, because half rebuilds half a stopover", async () => {
    // `recomputeItinerarySelection` reads the free-time window off one leg and the
    // departure off the other. One without the other is how #243's swap left the window
    // describing a trip nobody is taking.
    const provider = fixtureProvider((query) => ({
      ok: true,
      data: query.from === GATWICK ? [transfer("drive", 10)] : [],
      source: source("osrm-fixture"),
      requestsUsed: 1,
    }));

    const routing = await routeToProperty(inputWith([provider]));

    expect(routing.kind).toBe("no-route");
  });

  it("separates a provider that answered with nothing from one that could not be asked", async () => {
    // AGENTS.md, "show the error you got, never the one you assumed": the panel says
    // different sentences for these two and merging them is the mistake #203 already fixed
    // once for stays.
    const answered = fixtureProvider(() => ({
      ok: true,
      data: [],
      source: source("answered"),
      requestsUsed: 1,
    }));
    const broke = fixtureProvider(
      () => ({
        ok: false,
        error: { code: "quota-exceeded", message: "Too Many Requests", status: 429 },
        source: source("broke"),
        requestsUsed: 1,
      }),
      "broke",
    );

    expect((await routeToProperty(inputWith([answered]))).kind).toBe("no-route");

    const failed = await routeToProperty(inputWith([broke]));
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    // The provider's own words, its own code and its own status. AGENTS.md: "403 versus
    // 200-with-an-error-body is exactly the distinction that went missing".
    expect(failed.message).toBe("quota-exceeded 429: Too Many Requests");
  });

  it("asks for the ride rated against the airport's country and priced in the traveller's currency", async () => {
    // Issue #356. Both of these were absent at the one call site and neither absence
    // broke anything loudly. `osrm.ts` reads them off the query, and with no country it
    // returns a taxi carrying no `fareEstimate` at all, so a bed swap produced a ride with
    // no price beside beds whose rides had one.
    const asked: TransferSearchQuery[] = [];
    const provider = fixtureProvider((query) => {
      asked.push(query);
      return {
        ok: true,
        data: [transfer("drive", 10)],
        source: source("osrm-fixture"),
        requestsUsed: 1,
      };
    });

    await routeToProperty({
      ...inputWith([provider]),
      displayCurrency: "GBP",
      travellers: 3,
    });

    expect(asked).toHaveLength(2);
    for (const query of asked) {
      expect(query.countryCode).toBe("GB");
      expect(query.displayCurrency).toBe("GBP");
      expect(query.travellers).toBe(3);
    }
  });

  it("hands the swapped bed a taxi with a fare, converted into the traveller's currency", async () => {
    // The end of the same thread, run through the real adapter rather than a fixture
    // provider. The rate card is British, the traveller asked for euros, and the estimate
    // that reaches the panel has to be in euros with the pounds still on it (issue #339).
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("routed-foot")) {
        throw new Error("no foot route should be asked for a bed 12 km away");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ code: "Ok", routes: [{ duration: 1500, distance: 14500 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const provider = createOsrmTransferProvider({
      store: new MemoryCacheStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: "https://example.test",
    });

    const routing = await routeToProperty({
      ...inputWith([provider]),
      propertyCoordinates: FAR_BED,
    });

    if (routing.kind !== "routed") throw new Error(`expected routed, got ${routing.kind}`);
    expect(routing.transferToHotel.mode).toBe("taxi");
    const fare = routing.transferToHotel.fareEstimate;
    if (fare?.kind !== "estimate") {
      throw new Error(`expected an estimate, got ${fare?.kind ?? "nothing at all"}`);
    }
    expect(fare.countryCode).toBe("GB");
    // The card's own arithmetic over 14.5 km: 300 + 280 * 14.5 and 380 + 450 * 14.5, in
    // pence. Asserted unconverted, because the euro figures move with every rates refresh
    // and these do not.
    expect(fare.converted?.from).toBe("GBP");
    expect(fare.converted?.fromLowMinorUnits).toBe(4360);
    expect(fare.converted?.fromHighMinorUnits).toBe(6905);
    expect(fare.currency).toBe("EUR");
    expect(fare.lowMinorUnits).toBeGreaterThan(fare.converted!.fromLowMinorUnits);
  });

  it("splits that fare across the party the trip is for (issue #344)", async () => {
    // The third argument of the same trio, on the same call. A car's meter charges the
    // car, so three travellers sharing it pay a third each, and the panel beside this one
    // prints the trip's totals for the same three people.
    // A fresh `Response` per call, never one shared: a body can only be read once, and a
    // second reader gets a failure that looks exactly like the provider refusing.
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: "Ok", routes: [{ duration: 1500, distance: 14500 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = createOsrmTransferProvider({
      store: new MemoryCacheStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: "https://example.test",
    });

    const routing = await routeToProperty({
      ...inputWith([provider]),
      propertyCoordinates: FAR_BED,
      displayCurrency: "GBP",
      travellers: 3,
    });

    if (routing.kind !== "routed") throw new Error(`expected routed, got ${routing.kind}`);
    const fare = routing.transferToHotel.fareEstimate;
    if (fare?.kind !== "estimate") {
      throw new Error(`expected an estimate, got ${fare?.kind ?? "nothing at all"}`);
    }
    if (fare.party?.basis !== "per-vehicle") {
      throw new Error(`expected a per-vehicle split, got ${fare.party?.basis ?? "no party"}`);
    }
    expect(fare.party.people).toBe(3);
    // One car holds them, so the party pays what the card says and each of them pays a
    // third of it. Without `travellers` on the query there is no `party` at all and the
    // panel has nothing to divide.
    expect(fare.party.perVehicleLowMinorUnits).toBe(4360);
    expect(fare.party.perPersonLowMinorUnits).toBe(Math.round(4360 / 3));
  });

  it("drops a route no traveller could take rather than offering it (issue #119)", async () => {
    // 2.8 km is not an eleven-hour walk. `isPlausibleTransfer` runs inside
    // `fetchBestTransfer`, so this function inherits the gate rather than needing its own.
    const provider = fixtureProvider(() => ({
      ok: true,
      data: [transfer("walk", 702)],
      source: source("osrm-fixture"),
      requestsUsed: 1,
    }));

    expect((await routeToProperty(inputWith([provider]))).kind).toBe("no-route");
  });
});
