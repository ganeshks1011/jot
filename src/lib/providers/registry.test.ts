import { describe, expect, it } from "vitest";
import { isRetiredModel } from "./openai";
import {
  GEMINI_ADAPTER,
  getAdapter,
  getAllAdapters,
  getRecommendedModels,
  GROK_ADAPTER,
  OPENAI_ENDPOINT_PRESETS,
} from "./registry";

describe("builtin provider order", () => {
  it("lists Jot rewrite API first", () => {
    const ids = getAllAdapters().map((a) => a.id);
    expect(ids[0]).toBe("jot-api");
  });

  it("labels the first entry Jot rewrite API", () => {
    expect(getAllAdapters()[0]?.label).toBe("Jot rewrite API");
  });
});

describe("removed providers", () => {
  it("has no deepseek adapter", () => {
    expect(getAdapter("deepseek")).toBeUndefined();
    expect(getAllAdapters().some((a) => a.id === "deepseek")).toBe(false);
  });

  it("has no legacy wurkflo id", () => {
    expect(getAdapter("wurkflo")).toBeUndefined();
  });
});

describe("recommended models", () => {
  it("recommends 3.5-flash-lite for Gemini", () => {
    expect(getRecommendedModels("gemini")).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("recommends haiku for Anthropic", () => {
    expect(getRecommendedModels("anthropic")).toEqual(["claude-haiku-4-5"]);
  });

  it("registers Grok as a builtin with a recommended model", () => {
    expect(getAdapter("grok")).toBe(GROK_ADAPTER);
    expect(getAllAdapters().some((a) => a.id === "grok")).toBe(true);
    expect(getRecommendedModels("grok")).toEqual(["grok-4.3"]);
  });

  it("returns an empty list for unknown and custom providers", () => {
    expect(getRecommendedModels("some-custom")).toEqual([]);
  });

  it("uses a bare Gemini default model (no models/ prefix)", () => {
    expect(GEMINI_ADAPTER.defaultModel).toBe("gemini-3.5-flash-lite");
  });

  it("no longer retires Gemini 2.5 models", () => {
    expect(isRetiredModel("gemini-2.5-flash-lite")).toBe(false);
    expect(isRetiredModel("gemini-2.5-flash")).toBe(false);
  });
});

describe("OPENAI_ENDPOINT_PRESETS", () => {
  it("includes DeepSeek via the OpenAI-compatible endpoint", () => {
    const deepseek = OPENAI_ENDPOINT_PRESETS.find((p) => p.label === "DeepSeek");
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("has non-empty labels and base URLs", () => {
    expect(OPENAI_ENDPOINT_PRESETS.length).toBeGreaterThan(0);
    for (const p of OPENAI_ENDPOINT_PRESETS) {
      expect(p.label.trim()).not.toBe("");
      expect(p.baseUrl.trim()).not.toBe("");
    }
  });
});
