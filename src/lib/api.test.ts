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

import { browser } from "wxt/browser";
import { listModels, ProviderError, parseKeyedRewrites, rewriteLexicalNodes, rewriteText } from "./api";
import { clearResponseCache } from "./responseCache";
import { saveApiKey, saveBackendConfig } from "./storage";

const STORED_URL = "https://stored.example.com/v1";

const relayCalls: Array<{ body: unknown }> = [];
let pendingFrames: string[] = [];

vi.mock("./net", () => ({
  relayStream: async (req: { body?: string }, handlers: { onChunk: (raw: string) => void }) => {
    relayCalls.push({ body: req.body ? JSON.parse(req.body) : null });
    for (const frame of pendingFrames.splice(0)) handlers.onChunk(frame);
  },
}));

vi.mock("./auth", () => ({
  getWurkfloToken: async () => "test-token",
}));

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

describe("parseKeyedRewrites", () => {
  const ids = ["0/0", "1/0/0"];

  it("parses an exact map", () => {
    expect(parseKeyedRewrites('{"rewrites":{"0/0":"Hi","1/0/0":"uno"}}', ids)).toEqual({
      "0/0": "Hi",
      "1/0/0": "uno",
    });
  });

  it("slices the outermost object out of surrounding prose", () => {
    const raw = 'Sure! {"rewrites":{"0/0":"Hi","1/0/0":"uno"}} done.';
    expect(parseKeyedRewrites(raw, ids)).toEqual({ "0/0": "Hi", "1/0/0": "uno" });
  });

  it("ignores extra ids but requires every expected id", () => {
    const raw = '{"rewrites":{"0/0":"Hi","1/0/0":"uno","9/9":"extra"}}';
    expect(parseKeyedRewrites(raw, ids)).toEqual({ "0/0": "Hi", "1/0/0": "uno" });
    expect(parseKeyedRewrites('{"rewrites":{"0/0":"Hi"}}', ids)).toBeNull();
  });

  it("rejects blank values and malformed payloads", () => {
    expect(parseKeyedRewrites('{"rewrites":{"0/0":"  ","1/0/0":"uno"}}', ids)).toBeNull();
    expect(parseKeyedRewrites("not json at all", ids)).toBeNull();
    expect(parseKeyedRewrites('{"nope":{}}', ids)).toBeNull();
    expect(parseKeyedRewrites("", ids)).toBeNull();
  });
});

describe("rewriteLexicalNodes", () => {
  const nodes = [
    { id: "0/0", text: "Hello world", block: "paragraph" },
    { id: "1/0/0", text: "one", block: "listitem" },
  ];

  beforeEach(async () => {
    relayCalls.length = 0;
    pendingFrames = [];
    await saveBackendConfig({ provider: "jot-api", baseUrl: "", model: "" });
    await browser.storage.local.set({ "jot:wurkfloUser": { uid: "u", email: null } });
  });

  it("throws without hitting the network when nodes are empty", async () => {
    await expect(rewriteLexicalNodes([])).rejects.toMatchObject({ kind: "empty" });
    expect(relayCalls).toHaveLength(0);
  });

  it("throws for non-jot-api providers so callers fall back", async () => {
    await saveBackendConfig({ provider: "openai", baseUrl: STORED_URL, model: "stored-model" });
    const err = await rewriteLexicalNodes(nodes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(relayCalls).toHaveLength(0);
  });

  it("sends nodes and returns the parsed map without streaming chunks", async () => {
    pendingFrames = [
      'data: {"content":"{\\"rewrites\\":{\\"0/0\\":\\"Hi\\","}\n\n',
      'data: {"content":"\\"1/0/0\\":\\"uno\\"}}"}\n\n',
      "data: [DONE]\n\n",
    ];
    const onChunk = vi.fn();
    const map = await rewriteLexicalNodes(nodes, { site: "reddit.com", handlers: { onChunk } });
    expect(map).toEqual({ "0/0": "Hi", "1/0/0": "uno" });
    expect(onChunk).not.toHaveBeenCalled();
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.body).toMatchObject({ nodes });
    const body = relayCalls[0]?.body as Record<string, unknown>;
    expect(typeof body.systemPrompt).toBe("string");
  });

  it("throws empty when the model response has no usable map", async () => {
    pendingFrames = ['data: {"content":"hello plain text"}\n\n', "data: [DONE]\n\n"];
    await expect(rewriteLexicalNodes(nodes)).rejects.toMatchObject({ kind: "empty" });
  });

  it("serves identical keyed requests from cache without a second relay", async () => {
    await clearResponseCache();
    pendingFrames = [
      'data: {"content":"{\\"rewrites\\":{\\"0/0\\":\\"Hi\\","}\n\n',
      'data: {"content":"\\"1/0/0\\":\\"uno\\"}}"}\n\n',
      "data: [DONE]\n\n",
    ];
    const first = await rewriteLexicalNodes(nodes, { site: "reddit.com" });
    expect(first).toEqual({ "0/0": "Hi", "1/0/0": "uno" });
    expect(relayCalls).toHaveLength(1);
    pendingFrames = [];
    const second = await rewriteLexicalNodes(nodes, { site: "reddit.com" });
    expect(second).toEqual(first);
    expect(relayCalls).toHaveLength(1);
  });
});

describe("rewriteText response cache", () => {
  beforeEach(async () => {
    relayCalls.length = 0;
    pendingFrames = [];
    await clearResponseCache();
    await saveBackendConfig({ provider: "jot-api", baseUrl: "", model: "" });
    await browser.storage.local.set({ "jot:wurkfloUser": { uid: "u", email: null } });
  });

  it("streams once, then serves the same rewrite from cache", async () => {
    pendingFrames = ['data: {"content":"Hello "}\n\n', 'data: {"content":"there"}\n\n', "data: [DONE]\n\n"];
    const firstChunks: string[] = [];
    const first = await rewriteText("hello there", "reddit.com", undefined, {
      onChunk: (delta) => {
        firstChunks.push(delta);
      },
    });
    expect(first).toBe("Hello there");
    expect(relayCalls).toHaveLength(1);
    expect(firstChunks.join("")).toBe("Hello there");
    pendingFrames = [];
    const secondChunks: string[] = [];
    const second = await rewriteText("hello there", "reddit.com", undefined, {
      onChunk: (delta) => {
        secondChunks.push(delta);
      },
    });
    expect(second).toBe("Hello there");
    expect(relayCalls).toHaveLength(1);
    expect(secondChunks).toEqual(["Hello there"]);
  });
});
