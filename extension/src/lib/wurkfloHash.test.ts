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
    remove: async (keys: string[]) => {
      for (const k of keys) delete store[k];
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

vi.mock("./auth", () => ({
  getWurkfloToken: async () => "test-token",
}));

vi.mock("./net", () => ({
  relayStream: vi.fn(),
}));

import { browser } from "wxt/browser";
import { rewriteText, rewriteWithInstruction } from "./api";
import { relayStream } from "./net";
import { saveBackendConfig } from "./storage";

const relayStreamMock = vi.mocked(relayStream);

interface StreamHandlers {
  onChunk: (raw: string) => void;
  onRemaining?: (n: number) => void;
  onPromptHash?: (hash: string) => void;
}

const requests: Array<Record<string, unknown>> = [];

/** Simulate a successful SSE stream carrying content plus a prompt-hash frame. */
function succeedWithHash(hash: string, content = "rewritten text") {
  return async (req: { body?: string }, handlers: StreamHandlers): Promise<void> => {
    requests.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
    handlers.onPromptHash?.(hash);
    handlers.onChunk(
      `data: ${JSON.stringify({ content })}\n\ndata: ${JSON.stringify({ systemPromptHash: hash })}\n\ndata: [DONE]\n\n`,
    );
  };
}

function invalidHashError(hash: string) {
  const err = new Error("Request failed (400)") as Error & {
    status?: number;
    body?: string;
  };
  err.status = 400;
  err.body = JSON.stringify({
    success: false,
    error: {
      code: "invalid_system_prompt_hash",
      message: "Unknown systemPromptHash. Re-send the full systemPrompt.",
      systemPromptHash: hash,
      retryWith: "systemPrompt",
    },
  });
  return err;
}

beforeEach(async () => {
  requests.length = 0;
  relayStreamMock.mockReset();
  await saveBackendConfig({
    provider: "jot-api",
    baseUrl: "https://wurkflo.app",
    model: "deepseek-chat",
  });
  // storage.ts reads the mirrored user from this local key (WURKFLO_USER_KEY).
  await browser.storage.local.set({
    "jot:wurkfloUser": { uid: "u1", email: null },
  });
});

describe("wurkflo systemPromptHash", () => {
  it("sends the full prompt first, then hash-only on the next rewrite", async () => {
    relayStreamMock.mockImplementation(succeedWithHash("hash-1"));
    const out1 = await rewriteWithInstruction("source one", "instruction one");
    expect(out1).toBe("rewritten text");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveProperty("systemPrompt");
    expect(requests[0]).not.toHaveProperty("systemPromptHash");

    const out2 = await rewriteWithInstruction("source two", "instruction one");
    expect(out2).toBe("rewritten text");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ systemPromptHash: "hash-1", input: "source two" });
  });

  it("retries once with the full prompt on invalid_system_prompt_hash", async () => {
    relayStreamMock.mockImplementation(succeedWithHash("hash-2"));
    await rewriteWithInstruction("priming source", "instruction two");

    relayStreamMock.mockImplementationOnce(async (req: { body?: string }) => {
      requests.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
      throw invalidHashError("hash-2");
    });
    relayStreamMock.mockImplementationOnce(succeedWithHash("hash-3"));

    const out = await rewriteWithInstruction("retry source", "instruction two");
    expect(out).toBe("rewritten text");
    // priming + hash-only attempt + full-prompt retry
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual({ systemPromptHash: "hash-2", input: "retry source" });
    expect(requests[2]).toHaveProperty("systemPrompt");
    expect(requests[2]).not.toHaveProperty("systemPromptHash");
  });

  it("learns the hash from the header alone, without a hash frame", async () => {
    relayStreamMock.mockImplementation(async (req: { body?: string }, handlers: StreamHandlers): Promise<void> => {
      requests.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
      handlers.onPromptHash?.("header-hash");
      handlers.onChunk('data: {"content":"rewritten text"}\n\ndata: [DONE]\n\n');
    });
    await rewriteWithInstruction("header source", "instruction three");
    await rewriteWithInstruction("header source 2", "instruction three");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ systemPromptHash: "header-hash", input: "header source 2" });
  });
});

describe("wurkflo html flag (frontend/backend compatibility)", () => {
  it("omits html for plain inputs (previous-frontend payload shape)", async () => {
    relayStreamMock.mockImplementation(succeedWithHash("hash-plain"));
    await rewriteText("just some plain words");
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("html");
    expect(requests[0]).toHaveProperty("systemPrompt");
    expect(requests[0]).toHaveProperty("input", "just some plain words");
  });

  it("sends html:true with the HTML fragment for formatted inputs", async () => {
    relayStreamMock.mockImplementation(succeedWithHash("hash-html"));
    await rewriteText("hi there", undefined, undefined, undefined, {
      html: "<p>hi <b>there</b></p>",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveProperty("input", "<p>hi <b>there</b></p>");
    expect(requests[0]).toHaveProperty("html", true);
  });

  it("preserves html:true on the full-prompt retry after a stale hash", async () => {
    relayStreamMock.mockImplementation(succeedWithHash("hash-retry"));
    await rewriteText("hi there", undefined, undefined, undefined, {
      html: "<p>hi <b>there</b></p>",
    });

    relayStreamMock.mockImplementationOnce(async (req: { body?: string }) => {
      requests.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
      throw invalidHashError("hash-retry");
    });
    relayStreamMock.mockImplementationOnce(succeedWithHash("hash-retry-2"));

    await rewriteText("hi again", undefined, undefined, undefined, {
      html: "<p>hi <b>again</b></p>",
    });
    const retry = requests[requests.length - 1] as Record<string, unknown>;
    expect(retry).toHaveProperty("systemPrompt");
    expect(retry).not.toHaveProperty("systemPromptHash");
    expect(retry).toHaveProperty("html", true);
  });
});
