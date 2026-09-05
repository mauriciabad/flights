import { describe, expect, it } from "vitest";
import { DEFAULT_LANDING_TO_TRANSPORT_RULES } from "../domain";
import type { Coordinates, Duration, Transfer } from "../domain";
import type {
  ProviderId,
  ProviderResult,
  ProviderSource,
  TransferProvider,
  TransferSearchQuery,
} from "../providers/types";
import { routeToProperty } from "./route-to-property";

const GATWICK: Coordinates = { latitude: 51.1537, longitude: -0.1821 };
/** The Gatwick White House Hotel, 2.8 km out — issue #267's own acceptance property. */
const WHITE_HOUSE: Coordinates = { latitude: 51.1614, longitude: -0.1637 };

/** What the app actually ships (`domain/waiting-time.ts`): 15 minutes to get off the
 * plane and onto the street, 30 at a large airport. Gatwick is large. Asserting against
 * the real table rather than a fixture one, because the point of this test is that a bed
 * routed here lands at the same minute as the same bed routed by the pipeline. */
const RULES = DEFAULT_LANDING_TO_TRANSPORT_RULES;

function source(id: string): ProviderSource {
  return {
    providerId: id as ProviderId,
    label: `Fixture (${id})`,
    fetchedAt: new Date("2026-10-06T12:00:00Z"),
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
        error: { code: "http-error", message: "429 Too Many Requests" },
        source: source("broke"),
        requestsUsed: 1,
      }),
      "broke",
    );

    expect((await routeToProperty(inputWith([answered]))).kind).toBe("no-route");

    const failed = await routeToProperty(inputWith([broke]));
    if (failed.kind !== "failed") throw new Error(`expected failed, got ${failed.kind}`);
    // The provider's own words and its own code, not a paraphrase.
    expect(failed.message).toBe("http-error: 429 Too Many Requests");
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
