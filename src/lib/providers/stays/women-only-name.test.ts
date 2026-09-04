import { describe, expect, it } from "vitest";
import { isWomenOnlyPropertyName } from "./women-only-name";

describe("isWomenOnlyPropertyName", () => {
  it("catches the property the owner was shown for a party with no female travellers", () => {
    expect(isWomenOnlyPropertyName("Hostelle - women only hostel London")).toBe(
      true,
    );
  });

  it.each([
    "Women Only Hostel Barcelona",
    "The Women-Only Guesthouse",
    "Ladies only hostel",
    "Girls Only Hostel Rome",
    "Amelie's Female Only Hostel",
  ])("catches %s", (name) => {
    expect(isWomenOnlyPropertyName(name)).toBe(true);
  });

  it.each([
    "Wombats City Hostel",
    "Rest Up London",
    // The word alone is not the claim. Hiding these would cost a traveller beds they
    // could have booked, which is the worse of the two mistakes here.
    "Ladies Court Hotel",
    "Girls School Boutique Rooms",
    "Female Statue Guesthouse",
  ])("leaves %s alone", (name) => {
    expect(isWomenOnlyPropertyName(name)).toBe(false);
  });
});
