import { describe, expect, it } from "vitest";
import {
  BUILTIN_SITE_PERSONAS,
  buildPersonaPrompt,
  findBuiltinPersona,
  GLOBAL_CHARACTER_RULE,
  matchesSite,
} from "./sitePersonas";

describe("matchesSite", () => {
  // Test the actual behavior observed
  it("bare example.com matches example.com and subdomain mail.example.com, but NOT notexample.com or example.com.evil.com", () => {
    expect(matchesSite("example.com", "example.com")).toBe(true);
    expect(matchesSite("example.com", "mail.example.com")).toBe(true);
    expect(matchesSite("example.com", "notexample.com")).toBe(false);
    expect(matchesSite("example.com", "example.com.evil.com")).toBe(false);
  });

  it("*.example.com matches mail.example.com and also its apex example.com", () => {
    const result1 = matchesSite("*.example.com", "mail.example.com");
    const result2 = matchesSite("*.example.com", "example.com");

    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });

  it("https://example.com (with scheme prefix) is normalized and matches example.com", () => {
    expect(matchesSite("https://example.com", "example.com")).toBe(true);
    expect(matchesSite("https://example.com", "mail.example.com")).toBe(true);
  });

  it("matching is case-insensitive", () => {
    expect(matchesSite("EXAMPLE.COM", "example.com")).toBe(true);
    expect(matchesSite("Example.Com", "EXAMPLE.COM")).toBe(true);
  });

  it("empty pattern → false; empty/whitespace hostname → false", () => {
    expect(matchesSite("", "example.com")).toBe(false);
    expect(matchesSite("   ", "example.com")).toBe(false);
    expect(matchesSite("example.com", "")).toBe(false);
    expect(matchesSite("example.com", "   ")).toBe(false);
  });
});

describe("findBuiltinPersona", () => {
  it("linkedin.com → linkedin persona; x.com and twitter.com → the x persona; facebook.com → facebook", () => {
    expect(findBuiltinPersona("linkedin.com")).toMatchObject({ id: "linkedin" });
    expect(findBuiltinPersona("x.com")).toMatchObject({ id: "x" });
    expect(findBuiltinPersona("twitter.com")).toMatchObject({ id: "x" });
    expect(findBuiltinPersona("facebook.com")).toMatchObject({ id: "facebook" });
  });

  it("unknown host → null; empty/whitespace → null", () => {
    expect(findBuiltinPersona("unknown.com")).toBeNull();
    expect(findBuiltinPersona("")).toBeNull();
    expect(findBuiltinPersona("   ")).toBeNull();
  });
});

describe("buildPersonaPrompt", () => {
  it("returns the persona's prompt plus the GLOBAL_CHARACTER_RULE", () => {
    const persona = BUILTIN_SITE_PERSONAS[0]!;
    const result = buildPersonaPrompt(persona);

    expect(result).toContain(persona!.prompt);
    expect(result).toContain(GLOBAL_CHARACTER_RULE);
  });
});

describe("BUILTIN_SITE_PERSONAS", () => {
  it("entries are well-formed: each has a non-empty id, label, non-empty hostnames array, non-empty prompt, and ids are unique", () => {
    // Check that we have all expected personas
    expect(BUILTIN_SITE_PERSONAS).toHaveLength(4);

    const ids = new Set<string>();
    for (const persona of BUILTIN_SITE_PERSONAS) {
      // Check non-empty id
      expect(persona.id).toBeTruthy();
      expect(persona.id).toBeDefined();

      // Check non-empty label
      expect(persona.label).toBeTruthy();
      expect(persona.label).toBeDefined();

      // Check non-empty hostnames array
      expect(Array.isArray(persona.hostnames)).toBe(true);
      expect(persona.hostnames.length).toBeGreaterThan(0);

      // Check non-empty prompt
      expect(persona.prompt).toBeTruthy();
      expect(persona.prompt).toBeDefined();

      // Check id uniqueness
      expect(ids.has(persona.id)).toBe(false);
      ids.add(persona.id);
    }
  });
});
