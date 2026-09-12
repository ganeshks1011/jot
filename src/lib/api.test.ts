import { beforeEach, describe, expect, it, vi } from "vitest";

function makeArea() {
  const store: Record<string, unknown> = {};
  const pick = (keys?: string | string[] | null) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
  };
  return {
    get: async (keys?: string | string[] | null) => pick(keys),
    set: async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
}

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      sync: makeArea(),
      local: makeArea(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
}));

const captured: Array<{ config: unknown; apiKey: unknown }> = [];

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    getAdapter: () => ({
      id: "openai",
      label: "OpenAI",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
      tiersEnforcedServerSide: false,
      rewrite: async () => {
        throw new Error("not under test");
      },
      listModels: async (config: unknown, apiKey: unknown) => {
        captured.push({ config, apiKey });
        return ["m1", "m2"];
      },
    }),
  };
});

import { listModels } from "./api";
import { saveApiKey, saveBackendConfig } from "./storage";

const STORED_URL = "https://stored.example.com/v1";

beforeEach(async () => {
  captured.length = 0;
  await saveBackendConfig({ provider: "openai", baseUrl: STORED_URL, model: "stored-model" });
  await saveApiKey("stored-key", "openai");
});

describe("listModels endpoint override", () => {
  it("queries the override URL, model, and key instead of the saved config", async () => {
    const models = await listModels({
      provider: "openai",
      baseUrl: "https://selected.example.com/v1",
      model: "selected-model",
      apiKey: "selected-key",
    });
    expect(models).toEqual(["m1", "m2"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.config).toMatchObject({
      provider: "openai",
      baseUrl: "https://selected.example.com/v1",
      model: "selected-model",
    });
    expect(captured[0]?.apiKey).toBe("selected-key");
  });

  it("falls back to the saved config when called without overrides", async () => {
    await listModels();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.config).toMatchObject({
      provider: "openai",
      baseUrl: STORED_URL,
      model: "stored-model",
    });
    expect(captured[0]?.apiKey).toBe("stored-key");
  });

  it("falls back to the saved URL when the override is blank", async () => {
    await listModels({ provider: "openai", baseUrl: "   ", model: "m", apiKey: "k" });
    expect(captured[0]?.config).toMatchObject({ baseUrl: STORED_URL });
  });
});
