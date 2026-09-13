import { describe, expect, it } from "vitest";
import { headersToText, validateCustomProvider } from "./customProvider";

describe("validateCustomProvider", () => {
  it("requires label, baseUrl, model", () => {
    expect(validateCustomProvider({ label: "", baseUrl: "https://a", model: "m" }).error).toBeTruthy();
    expect(validateCustomProvider({ label: "a", baseUrl: "", model: "m" }).error).toBeTruthy();
  });

  it("validates URL", () => {
    expect(validateCustomProvider({ label: "a", baseUrl: "not-a-url", model: "m" }).error).toMatch(/valid URL/);
  });

  it("parses headers", () => {
    const r = validateCustomProvider({ label: "a", baseUrl: "https://a", model: "m", headersText: "X: 1\nY: 2" });
    expect(r.meta?.extraHeaders).toEqual({ X: "1", Y: "2" });
  });

  it("fails on bad header", () => {
    expect(validateCustomProvider({ label: "a", baseUrl: "https://a", model: "m", headersText: "bad" }).error).toMatch(
      /Key: Value/,
    );
  });

  it("returns meta on success", () => {
    const r = validateCustomProvider({ label: "My Provider", baseUrl: "https://a", model: "m" });
    expect(r.meta?.label).toBe("My Provider");
    expect(r.meta?.id).toBeTruthy();
  });

  it("preserves the existing id when editing", () => {
    const r = validateCustomProvider(
      { label: "Renamed", baseUrl: "https://a", model: "m", headersText: "X: 1" },
      "my-provider",
    );
    expect(r.meta?.id).toBe("my-provider");
    expect(r.meta?.label).toBe("Renamed");
    expect(r.meta?.extraHeaders).toEqual({ X: "1" });
  });

  it("round-trips headers through headersToText", () => {
    expect(headersToText(undefined)).toBe("");
    expect(headersToText({})).toBe("");
    const text = headersToText({ X: "1", Y: "2" });
    const r = validateCustomProvider({ label: "a", baseUrl: "https://a", model: "m", headersText: text });
    expect(r.meta?.extraHeaders).toEqual({ X: "1", Y: "2" });
  });

  it("accepts https and loopback key pages, rejects other schemes", () => {
    const base = { label: "a", baseUrl: "https://a", model: "m" };
    expect(validateCustomProvider({ ...base, apiKeyUrl: "https://a.example/keys" }).meta?.apiKeyUrl).toBe(
      "https://a.example/keys",
    );
    expect(validateCustomProvider({ ...base, apiKeyUrl: "http://localhost:8080/keys" }).meta?.apiKeyUrl).toBe(
      "http://localhost:8080/keys",
    );
    expect(validateCustomProvider({ ...base, apiKeyUrl: "http://keys.example/" }).error).toMatch(/https/);
    expect(validateCustomProvider({ ...base, apiKeyUrl: "javascript:alert(1)" }).error).toMatch(/https/);
    expect(validateCustomProvider({ ...base, apiKeyUrl: "not-a-url" }).error).toMatch(/valid URL/);
  });
});
