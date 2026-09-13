import { describe, expect, it } from "vitest";
import { compileSliders, resolveInstruction } from "./resolve";
import type { PersonalizationSnapshot } from "./types";

function snapshot(overrides: Partial<PersonalizationSnapshot> = {}): PersonalizationSnapshot {
  return {
    contexts: {
      default: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      email: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      ...overrides.contexts,
    },
    domains: overrides.domains ?? [],
  };
}

describe("resolveInstruction", () => {
  it("uses the exact-hostname site override", () => {
    const snap = snapshot({
      contexts: {
        default: { prompt: "Base voice", sliders: { casual: 3, direct: 3, length: 3 } },
        email: { prompt: "Email voice", sliders: { casual: 3, direct: 3, length: 3 } },
        text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      },
      domains: [{ context: "email", pattern: "gmail.com" }],
    });
    const r = resolveInstruction(snap, "gmail.com");
    expect(r.instruction).toBe("Email voice");
    expect(r.origin).toBe("site");
  });

  it("matches hostnames case-insensitively", () => {
    const snap = snapshot({
      domains: [{ context: "email", pattern: "gmail.com" }],
      contexts: {
        default: { prompt: "Base", sliders: { casual: 3, direct: 3, length: 3 } },
        email: { prompt: "Email voice", sliders: { casual: 3, direct: 3, length: 3 } },
        text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      },
    });
    expect(resolveInstruction(snap, "GMail.com").instruction).toBe("Email voice");
  });

  it("does not match subdomains (exact hostnames only)", () => {
    const snap = snapshot({
      contexts: {
        default: { prompt: "Base voice", sliders: { casual: 3, direct: 3, length: 3 } },
        email: { prompt: "Email voice", sliders: { casual: 3, direct: 3, length: 3 } },
        text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      },
      domains: [{ context: "email", pattern: "example.com" }],
    });
    const r = resolveInstruction(snap, "mail.example.com");
    expect(r.instruction).toBe("Base voice");
    expect(r.origin).toBe("base");
  });

  it("falls back to the base style without a matching site", () => {
    const snap = snapshot({
      contexts: {
        default: { prompt: "Base voice", sliders: { casual: 3, direct: 3, length: 3 } },
        email: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      },
    });
    const r = resolveInstruction(snap, "unknown.example");
    expect(r.instruction).toBe("Base voice");
    expect(r.origin).toBe("base");
  });

  it("falls back to the default instruction when nothing is configured", () => {
    const r = resolveInstruction(snapshot(), undefined);
    expect(r.instruction).toContain("Write clearly, naturally, and concisely");
    expect(r.origin).toBe("default");
  });

  it("uses the built-in persona when nothing else matches", () => {
    const r = resolveInstruction(snapshot(), "facebook.com");
    expect(r.instruction).toContain("Only use characters that a normal user could reasonably type");
    expect(r.origin).toBe("persona");
  });

  it("compiles site slider levels into the site instruction", () => {
    const snap = snapshot({
      contexts: {
        default: { prompt: "Base", sliders: { casual: 3, direct: 3, length: 3 } },
        email: {
          prompt: "Email voice",
          sliders: { casual: 1, direct: 3, length: 3 },
        },
        text: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        social: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
        work: { prompt: "", sliders: { casual: 3, direct: 3, length: 3 } },
      },
      domains: [{ context: "email", pattern: "gmail.com" }],
    });
    const r = resolveInstruction(snap, "gmail.com");
    expect(r.instruction).toContain("Email voice");
    expect(r.instruction).toContain("Relaxed, conversational, informal");
  });
});

describe("compileSliders", () => {
  it("leaves neutral levels untouched", () => {
    expect(compileSliders("Base voice", { casual: 3, direct: 3, length: 3 })).toBe("Base voice");
  });

  it("appends non-neutral directives", () => {
    const out = compileSliders("Base voice", {
      casual: 1,
      direct: 3,
      length: 2,
    });
    expect(out).toContain("Base voice");
    expect(out).toContain("Relaxed, conversational, informal");
    expect(out).toContain("Keep it concise");
  });

  it("does not duplicate existing directives", () => {
    const once = compileSliders("Base voice", {
      casual: 1,
      direct: 3,
      length: 3,
    });
    expect(compileSliders(once, { casual: 1, direct: 3, length: 3 })).toBe(once);
  });
});
