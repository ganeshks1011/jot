import { describe, expect, it } from "vitest";
import { isTransientRelayError, isTransientRelayMessage, isTransientTokenError } from "./transientErrors";

describe("isTransientRelayError", () => {
  it("detects relay-failed", () => {
    expect(isTransientRelayError(new Error("relay-failed"))).toBe(true);
  });
  it("detects stream-failed", () => {
    expect(isTransientRelayError("stream-failed")).toBe(true);
  });
  it("detects network-error", () => {
    expect(isTransientRelayError("network-error")).toBe(true);
  });
  it("detects Failed to fetch", () => {
    expect(isTransientRelayError("Failed to fetch")).toBe(true);
  });
  it("detects Receiving end does not exist", () => {
    expect(isTransientRelayError("Receiving end does not exist")).toBe(true);
  });
  it("detects Could not establish connection", () => {
    expect(isTransientRelayError("Could not establish connection")).toBe(true);
  });
  it("detects Extension context invalidated", () => {
    expect(isTransientRelayError("Extension context invalidated")).toBe(true);
  });
  it("detects Could not reach", () => {
    expect(isTransientRelayError("Could not reach Wurkflo backend")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isTransientRelayError("RELAY-FAILED")).toBe(true);
  });
  it("returns false for non-transient", () => {
    expect(isTransientRelayError("auth failed")).toBe(false);
    expect(isTransientRelayError("quota exceeded")).toBe(false);
  });
});

describe("isTransientRelayMessage", () => {
  it("mirrors isTransientRelayError for strings", () => {
    expect(isTransientRelayMessage("relay-failed")).toBe(true);
    expect(isTransientRelayMessage("hello")).toBe(false);
  });
});

describe("isTransientTokenError", () => {
  it("detects not-signed-in", () => {
    expect(isTransientTokenError("not-signed-in")).toBe(true);
  });
  it("detects auth-timeout", () => {
    expect(isTransientTokenError("auth-timeout")).toBe(true);
  });
  it("detects relay variants", () => {
    expect(isTransientTokenError("relay-failed")).toBe(true);
    expect(isTransientTokenError("stream-failed")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isTransientTokenError("NOT-SIGNED-IN")).toBe(true);
  });
  it("returns false for non-transient token errors", () => {
    expect(isTransientTokenError("quota")).toBe(false);
  });
});
