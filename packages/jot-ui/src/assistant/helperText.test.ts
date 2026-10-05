import { describe, expect, it } from "vitest";
import { selectHelperText } from "./helperText";

describe("selectHelperText", () => {
  it("returns null without output", () => {
    expect(selectHelperText({ hasOutput: false, focusZone: "content", hasTweakInput: false })).toBeNull();
    expect(selectHelperText({ hasOutput: false, focusZone: "feedback", hasTweakInput: true })).toBeNull();
  });

  it("returns replace for content focus or elsewhere", () => {
    expect(selectHelperText({ hasOutput: true, focusZone: "content", hasTweakInput: false })).toBe("replace");
    expect(selectHelperText({ hasOutput: true, focusZone: null, hasTweakInput: true })).toBe("replace");
  });

  it("returns tweak when the tweak box has input", () => {
    expect(selectHelperText({ hasOutput: true, focusZone: "feedback", hasTweakInput: true })).toBe("tweak");
  });

  it("returns invite when the tweak box is empty", () => {
    expect(selectHelperText({ hasOutput: true, focusZone: "feedback", hasTweakInput: false })).toBe("invite");
  });
});
