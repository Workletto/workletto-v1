import { describe, expect, it } from "vitest";
import { displayAppName, NEUTRAL_APP_NAME, PRODUCT_NAME } from "../src/shared/product.ts";

// A customer's app names itself after the customer, never after the vendor.
describe("displayAppName", () => {
  it("uses the app name the organization chose", () => {
    expect(displayAppName({ appName: "North Hours", name: "Studio North Ltd" })).toBe("North Hours");
  });

  it("falls back to the organization's name when there is no app name", () => {
    expect(displayAppName({ appName: null, name: "Studio North Ltd" })).toBe("Studio North Ltd");
    expect(displayAppName({ appName: "   ", name: "Studio North Ltd" })).toBe("Studio North Ltd");
    expect(displayAppName({ name: "Studio North Ltd" })).toBe("Studio North Ltd");
  });

  it("falls back to a neutral label before an organization exists", () => {
    expect(displayAppName(null)).toBe(NEUTRAL_APP_NAME);
    expect(displayAppName(undefined)).toBe(NEUTRAL_APP_NAME);
    expect(displayAppName({ appName: null, name: null })).toBe(NEUTRAL_APP_NAME);
    expect(displayAppName({ appName: "", name: "" })).toBe(NEUTRAL_APP_NAME);
  });

  it("never shows the vendor's name on its own", () => {
    expect(NEUTRAL_APP_NAME).not.toContain(PRODUCT_NAME);
    expect(displayAppName(null)).not.toBe(PRODUCT_NAME);
  });
});
