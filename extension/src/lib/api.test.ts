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

import { listModels, ProviderError, parseKeyedRewrites, rewriteLexicalNodes, rewriteText } from "./api";
import { saveApiKey, saveBackendConfig } from "./storage";

const STORED_URL = "https://stored.example.com/v1";

interface RelayCall {
  url: string;
  method?: string;
  body?: string;
}

const relayCalls: RelayCall[] = [];
let queuedResponses: Array<{ ok: boolean; status: number; text: string }> = [];

function queueCodevuRewrite(rewrite: string) {
  queuedResponses.push({ ok: true, status: 200, text: JSON.stringify({ ok: true, rewrite }) });
}

function requestBody(call: RelayCall): Record<string, unknown> {
  return call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {};
}

vi.mock("./net", () => ({
  relayFetch: async (req: RelayCall) => {
    relayCalls.push(req);
    const res = queuedResponses.shift();
    if (!res) throw new Error("no queued relay response");
    return res;
  },
}));

beforeEach(async () => {
  captured.length = 0;
  relayCalls.length = 0;
  queuedResponses = [];
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
    await saveBackendConfig({ provider: "jot-api", baseUrl: "", model: "" });
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

  it("rewrites each node through the codevu backend and returns the id map", async () => {
    queueCodevuRewrite("Hi");
    queueCodevuRewrite("uno");
    const onChunk = vi.fn();
    const map = await rewriteLexicalNodes(nodes, { handlers: { onChunk } });
    expect(map).toEqual({ "0/0": "Hi", "1/0/0": "uno" });
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(relayCalls).toHaveLength(2);
    const first = requestBody(relayCalls[0]!);
    expect(first.text).toBe("Hello world");
    expect(typeof first.installId).toBe("string");
    expect(relayCalls[0]!.url).toContain("/api/jot/v1/rewrite");
    expect(requestBody(relayCalls[1]!).text).toBe("one");
  });

  it("folds a follow-up refinement into each node request", async () => {
    queueCodevuRewrite("Hi");
    queueCodevuRewrite("uno");
    await rewriteLexicalNodes(nodes, { followUp: "shorter" });
    expect(relayCalls).toHaveLength(2);
    expect(String(requestBody(relayCalls[0]!).text)).toContain("Refinement request: shorter");
  });

  it("surfaces quota errors as quota provider errors", async () => {
    queuedResponses.push({ ok: false, status: 429, text: JSON.stringify({ error: "quota_exceeded" }) });
    await expect(rewriteLexicalNodes(nodes)).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("rewriteText through the codevu backend", () => {
  beforeEach(async () => {
    await saveBackendConfig({ provider: "jot-api", baseUrl: "", model: "" });
  });

  it("posts installId and text and returns the rewrite", async () => {
    queueCodevuRewrite("Hello there");
    const chunks: string[] = [];
    const out = await rewriteText("hello there", "reddit.com", undefined, {
      onChunk: (delta) => {
        chunks.push(delta);
      },
    });
    expect(out).toBe("Hello there");
    expect(chunks).toEqual(["Hello there"]);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toContain("/api/jot/v1/rewrite");
    const body = requestBody(relayCalls[0]!);
    expect(body.text).toBe("hello there");
    expect(typeof body.installId).toBe("string");
  });

  it("folds a follow-up refinement into the request text", async () => {
    queueCodevuRewrite("Hi");
    await rewriteText("hello", "reddit.com", "shorter");
    const body = requestBody(relayCalls[0]!);
    expect(String(body.text)).toContain("Refinement request: shorter");
  });

  it("surfaces quota errors as quota provider errors", async () => {
    queuedResponses.push({ ok: false, status: 429, text: JSON.stringify({ error: "quota_exceeded" }) });
    await expect(rewriteText("hello", "reddit.com")).rejects.toMatchObject({ kind: "quota" });
  });

  it("surfaces backend failures as network provider errors", async () => {
    queuedResponses.push({ ok: false, status: 500, text: JSON.stringify({ error: "rewrite_failed" }) });
    await expect(rewriteText("hello", "reddit.com")).rejects.toMatchObject({ kind: "network" });
  });
});
