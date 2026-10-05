import { describe, expect, it } from "vitest";
import { applyThemeTo, isThemeId, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("passes explicit themes through", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the OS preference for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("isThemeId", () => {
  it("accepts only known ids", () => {
    expect(isThemeId("dark")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });
});

describe("applyThemeTo", () => {
  it("sets data-theme and the dark class", () => {
    const toggled: [string, boolean?][] = [];
    const root = {
      dataset: {} as { theme?: string },
      classList: { toggle: (c: string, f?: boolean) => void toggled.push([c, f]) },
    };
    expect(applyThemeTo(root, "system", true)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(toggled).toContainEqual(["dark", true]);
  });
});
