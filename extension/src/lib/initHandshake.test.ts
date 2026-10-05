import { describe, expect, it } from "vitest";
import { buildInitKey, INIT_DEDUPE_WINDOW_MS, shouldSendInit } from "./initHandshake";

describe("buildInitKey", () => {
  it("distinguishes text, formatting, and host", () => {
    const base = buildInitKey("hi", false, 0, "mail.example");
    expect(buildInitKey("bye", false, 0, "mail.example")).not.toBe(base);
    expect(buildInitKey("hi", true, 10, "mail.example")).not.toBe(base);
    expect(buildInitKey("hi", false, 0, "other.example")).not.toBe(base);
    expect(base).toBe(base);
  });
});

describe("shouldSendInit", () => {
  const key = buildInitKey("hello", false, 0, "mail.example");

  it("sends the first init for a fresh key", () => {
    expect(shouldSendInit("", 0, key, 1000, false)).toBe(true);
  });

  it("drops a rapid repeat of the same key", () => {
    expect(shouldSendInit(key, 1000, key, 1000 + INIT_DEDUPE_WINDOW_MS - 1, false)).toBe(false);
  });

  it("delivers the ready retry even inside the dedupe window", () => {
    // When the first init is missed, the ready retry must still trigger a request.
    expect(shouldSendInit(key, 1000, key, 1000 + 60, true)).toBe(true);
  });

  it("sends a changed capture immediately", () => {
    const other = buildInitKey("changed", false, 0, "mail.example");
    expect(shouldSendInit(key, 1000, other, 1000 + 1, false)).toBe(true);
  });

  it("sends a repeat once the window expires", () => {
    expect(shouldSendInit(key, 1000, key, 1000 + INIT_DEDUPE_WINDOW_MS, false)).toBe(true);
  });
});
