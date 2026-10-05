import { describe, expect, it } from "vitest";
import { sliderLevelToDirective, sliderLevelToLabel } from "./sliders";

describe("sliderLevelToDirective", () => {
  it("returns null for level 3 (neutral)", () => {
    expect(sliderLevelToDirective("casual", 3)).toBeNull();
    expect(sliderLevelToDirective("direct", 3)).toBeNull();
    expect(sliderLevelToDirective("length", 3)).toBeNull();
  });
  it("returns directive for level 1 and 5", () => {
    expect(sliderLevelToDirective("casual", 1)).toContain("Relaxed");
    expect(sliderLevelToDirective("casual", 5)).toContain("Formal");
    expect(sliderLevelToDirective("direct", 1)).toContain("straight to the point");
    expect(sliderLevelToDirective("length", 5)).toContain("thorough");
  });
});

describe("sliderLevelToLabel", () => {
  it("returns correct labels", () => {
    expect(sliderLevelToLabel("casual", 1)).toBe("Very Casual");
    expect(sliderLevelToLabel("casual", 3)).toBe("Neutral");
    expect(sliderLevelToLabel("direct", 5)).toBe("Very Gentle");
    expect(sliderLevelToLabel("length", 2)).toBe("Short");
  });
});
