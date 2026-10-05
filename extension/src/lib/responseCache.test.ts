import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAreas = vi.hoisted(() => {
  const makeArea = () => {
    const store: Record<string, unknown> = {};
    return {
      get: async (keys?: string | string[] | null) => {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    };
  };
  return { local: makeArea(), sync: makeArea() };
});

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      sync: mockAreas.sync,
      local: mockAreas.local,
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
}));

import { buildResponseKey, cachedResponseFor, clearResponseCache, storeResponse } from "./responseCache";

const parts = {
  provider: "jot-api",
  model: "deepseek-v4-flash",
  systemPrompt: "Rewrite it clearly.",
  source: "hello there",
};

beforeEach(async () => {
  await clearResponseCache();
});

describe("buildResponseKey", () => {
  it("is stable for identical parts", async () => {
    expect(await buildResponseKey(parts)).toBe(await buildResponseKey({ ...parts }));
  });

  it("changes when provider, model, prompt, source, or tweak changes", async () => {
    const base = await buildResponseKey(parts);
    expect(await buildResponseKey({ ...parts, provider: "openai" })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, model: "other" })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, systemPrompt: "Other." })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, source: "other" })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, followUp: "shorter" })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, html: "<p>x</p>" })).not.toBe(base);
    expect(await buildResponseKey({ ...parts, nodes: '[["0/0","x"]]' })).not.toBe(base);
  });
});

describe("response cache round-trip", () => {
  it("misses empty, hits after store", async () => {
    const key = await buildResponseKey(parts);
    expect(await cachedResponseFor(key)).toBeNull();
    await storeResponse(key, "rewritten!");
    expect(await cachedResponseFor(key)).toBe("rewritten!");
  });

  it("evicts oldest beyond the entry cap", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 25; i++) {
      const key = await buildResponseKey({ ...parts, source: `text ${i}` });
      keys.push(key);
      await storeResponse(key, `out ${i}`);
    }
    expect(await cachedResponseFor(keys[0] as string)).toBeNull();
    expect(await cachedResponseFor(keys[keys.length - 1] as string)).toBe("out 24");
  });

  it("skips oversized bodies", async () => {
    const key = await buildResponseKey(parts);
    await storeResponse(key, "x".repeat(25000));
    expect(await cachedResponseFor(key)).toBeNull();
  });

  it("tolerates corrupt stored shapes", async () => {
    await mockAreas.local.set({ "jot:responseCache": { v: 999, entries: "nope" } });
    expect(await cachedResponseFor("anything")).toBeNull();
    const key = await buildResponseKey(parts);
    await storeResponse(key, "recovered");
    expect(await cachedResponseFor(key)).toBe("recovered");
  });

  it("clear drops everything", async () => {
    const key = await buildResponseKey(parts);
    await storeResponse(key, "x");
    await clearResponseCache();
    expect(await cachedResponseFor(key)).toBeNull();
  });
});
