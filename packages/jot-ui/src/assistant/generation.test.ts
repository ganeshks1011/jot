import { describe, expect, it } from "vitest";
import { buildCacheKey, isCacheHit } from "./generation";

describe("buildCacheKey", () => {
  it("joins text, followUp, site with ||", () => {
    expect(buildCacheKey("hello", "shorter", "gmail.com")).toBe("hello||shorter||gmail.com");
  });
  it("handles undefined followUp/site as empty", () => {
    expect(buildCacheKey("hi", undefined, undefined)).toBe("hi||||");
  });
  it("distinguishes different followUp", () => {
    expect(buildCacheKey("a", "x", "s")).not.toBe(buildCacheKey("a", "y", "s"));
  });
  it("appends HTML only when formatting is present", () => {
    expect(buildCacheKey("a", "x", "s")).toBe("a||x||s");
    expect(buildCacheKey("a", "x", "s", "<b>a</b>")).toBe("a||x||s||<b>a</b>");
    expect(buildCacheKey("a", "x", "s", null)).toBe("a||x||s");
  });
  it("appends prior output only when tweaking against one", () => {
    expect(buildCacheKey("a", "x", "s")).toBe("a||x||s");
    expect(buildCacheKey("a", "x", "s", null, "old")).toBe("a||x||s||old");
    expect(buildCacheKey("a", "x", "s", null, "old")).not.toBe(buildCacheKey("a", "x", "s", null, "new"));
  });
});

describe("isCacheHit", () => {
  it("true when keys equal and cached exists", () => {
    expect(isCacheHit("k", "k", "cached")).toBe(true);
  });
  it("false when keys differ", () => {
    expect(isCacheHit("a", "b", "cached")).toBe(false);
  });
  it("false when cached empty", () => {
    expect(isCacheHit("k", "k", "")).toBe(false);
    expect(isCacheHit("k", "k", undefined)).toBe(false);
  });
});
