import type { RoomKind, Stay } from "$lib/domain";
import { describe, expect, it } from "vitest";
import {
  genderFit,
  genderFitMessage,
  isGenderFitSelectable,
  isStayBookableByGroup,
  stayGenderFitMessage,
  stayRestrictedTo,
} from "./gendered-room-fit";

const at = (
  name: string,
  roomKind: RoomKind,
  womenOnly?: boolean,
): Stay => ({
  property: {
    name,
    coordinates: { latitude: 51.17, longitude: -0.17 },
    images: [],
    womenOnly,
  },
  roomKind,
  pricePerNight: { minorUnits: 2900, currency: "EUR" },
});

describe("genderFit for a women-only room", () => {
  it('is "none" when the group has zero female travellers - issue #27\'s hard rule', () => {
    expect(genderFit("female", 4, 0)).toBe("none");
    expect(genderFit("female", 1, 0)).toBe("none");
  });

  it('is "some" for a mixed group - females cover part of the party, not all of it', () => {
    expect(genderFit("female", 4, 1)).toBe("some");
    expect(genderFit("female", 4, 3)).toBe("some");
  });

  it('is "all" when every traveller is female', () => {
    expect(genderFit("female", 3, 3)).toBe("all");
    expect(genderFit("female", 1, 1)).toBe("all");
  });

  it('treats females exceeding travellers as "all" defensively rather than "some"', () => {
    expect(genderFit("female", 2, 5)).toBe("all");
  });

  it('is "unspecified" when females is absent, per search-query.ts: "not the same thing as 0"', () => {
    expect(genderFit("female", 2, undefined)).toBe("unspecified");
  });

  it("defaults travellers to DEFAULT_TRAVELLERS (1) when omitted, matching search-query.ts", () => {
    expect(genderFit("female", undefined, 1)).toBe("all");
    expect(genderFit("female", undefined, 0)).toBe("none");
  });
});

describe("genderFit for a men-only room", () => {
  // Issue #288: the mirror of every case above, because Hostelworld sells "Male Dorm"
  // rooms and the app used to class them as inventory anyone could book.
  it('is "none" when every traveller is female', () => {
    expect(genderFit("male", 2, 2)).toBe("none");
    expect(genderFit("male", 1, 1)).toBe("none");
  });

  it('is "all" when no traveller is female', () => {
    expect(genderFit("male", 3, 0)).toBe("all");
  });

  it('is "some" for a mixed group', () => {
    expect(genderFit("male", 4, 1)).toBe("some");
    expect(genderFit("male", 4, 3)).toBe("some");
  });

  it('is "unspecified" when females is absent, exactly as the female case is', () => {
    expect(genderFit("male", 2, undefined)).toBe("unspecified");
  });

  it("never reports a negative party when females exceeds travellers", () => {
    expect(genderFit("male", 2, 5)).toBe("none");
  });
});

describe("genderFit for an unrestricted room", () => {
  it('is "all" whatever the party looks like, and whatever females says', () => {
    expect(genderFit(undefined, 4, 0)).toBe("all");
    expect(genderFit(undefined, 4, 4)).toBe("all");
    expect(genderFit(undefined, 4, undefined)).toBe("all");
  });
});

describe("isGenderFitSelectable", () => {
  it('is false for "none" and "some" - a restricted room must never stand in as the group total', () => {
    expect(isGenderFitSelectable("none")).toBe(false);
    expect(isGenderFitSelectable("some")).toBe(false);
  });

  it('is true for "all" and "unspecified"', () => {
    expect(isGenderFitSelectable("all")).toBe(true);
    expect(isGenderFitSelectable("unspecified")).toBe(true);
  });
});

describe("genderFitMessage", () => {
  it('explains the shortfall by name for a mixed group, not just "unavailable"', () => {
    expect(genderFitMessage("female", "some", 4, 1)).toContain("1 of 4");
    expect(genderFitMessage("male", "some", 4, 1)).toContain("3 of 4");
  });

  it("states the zero-female case plainly", () => {
    expect(genderFitMessage("female", "none", 2, 0)).toMatch(
      /no female travellers/i,
    );
  });

  it("states the men-only case in its own words rather than the women-only ones", () => {
    const message = genderFitMessage("male", "none", 2, 2);
    expect(message).toMatch(/no male travellers/i);
    expect(message).toMatch(/men only/i);
  });

  it("names the assumption for the unspecified case rather than implying it was checked", () => {
    expect(genderFitMessage("female", "unspecified", 2, undefined)).toMatch(
      /no gender breakdown/i,
    );
  });

  it("has no caveat for a fully-eligible group, or for a room with no restriction", () => {
    expect(genderFitMessage("female", "all", 2, 2)).toBeUndefined();
    expect(genderFitMessage(undefined, "all", 2, 0)).toBeUndefined();
  });
});

describe("stayRestrictedTo", () => {
  it("catches a women-only property whose room is named like any other dorm", () => {
    // The defect the owner hit: both mappers classify by ROOM name, and "Hostelle -
    // women only hostel London" names its rooms ordinarily, so it reached a party with
    // no female travellers as their cheapest option.
    const stay = at("Hostelle - women only hostel London", "dorm", true);
    expect(stayRestrictedTo(stay)).toBe("female");
    expect(isStayBookableByGroup(stay, 2, 0)).toBe(false);
  });

  it("still catches a female dorm at a mixed property", () => {
    expect(stayRestrictedTo(at("Wombats City Hostel", "female-dorm"))).toBe(
      "female",
    );
  });

  it("catches a male dorm, which used to pass as an ordinary one (issue #288)", () => {
    const stay = at("Wiki Hostel Colive", "male-dorm");
    expect(stayRestrictedTo(stay)).toBe("male");
    expect(isStayBookableByGroup(stay, 2, 2)).toBe(false);
    expect(isStayBookableByGroup(stay, 2, 0)).toBe(true);
  });

  it("leaves an ordinary dorm at an ordinary property alone", () => {
    expect(stayRestrictedTo(at("Wombats City Hostel", "dorm"))).toBeUndefined();
    expect(isStayBookableByGroup(at("Wombats City Hostel", "dorm"), 2, 0)).toBe(
      true,
    );
  });
});

describe("stayGenderFitMessage", () => {
  it("answers about the restriction the stay actually carries", () => {
    expect(stayGenderFitMessage(at("A", "male-dorm"), 2, 2)).toMatch(
      /no male travellers/i,
    );
    expect(stayGenderFitMessage(at("A", "female-dorm"), 2, 0)).toMatch(
      /no female travellers/i,
    );
  });

  it("says nothing about an unrestricted room", () => {
    expect(stayGenderFitMessage(at("A", "dorm"), 2, 0)).toBeUndefined();
    expect(stayGenderFitMessage(at("A", "private"), 2, 0)).toBeUndefined();
  });
});
