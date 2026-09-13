import { describe, expect, it } from "vitest";
import { validateApiKey } from "./providerValidation";

describe("validateApiKey", () => {
  it("wurkflo no error", () => {
    expect(validateApiKey("jot-api", "")).toBeNull();
  });
  it("requires key for openai", () => {
    expect(validateApiKey("openai", "")).toMatch(/API key/);
    expect(validateApiKey("openai", "sk-123")).toBeNull();
  });
  it("allows localhost without key", () => {
    expect(validateApiKey("openai", "", "http://localhost:11434/v1")).toBeNull();
    expect(validateApiKey("openai", "", "http://127.0.0.1:11434/v1")).toBeNull();
    expect(validateApiKey("openai", "", "http://[::1]:11434/v1")).toBeNull();
  });
  it("checks gemini", () => {
    expect(validateApiKey("gemini", "")).toMatch(/Gemini/);
  });
});
