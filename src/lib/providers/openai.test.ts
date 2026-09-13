import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai";

const captured: Array<Record<string, unknown>> = [];
const capturedReqs: Array<{ url?: unknown; headers?: unknown }> = [];

vi.mock("../net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net")>();
  return {
    ...actual,
    relayFetch: vi.fn(async (req: { body?: string; url?: unknown; headers?: unknown }) => {
      captured.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
      capturedReqs.push({ url: req.url, headers: req.headers });
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: "done" } }] }),
      };
    }),
  };
});

const SYSTEM = "Be thoughtful and concise";
const USER = "A thoughtful rewrite please";

beforeEach(() => {
  captured.length = 0;
  capturedReqs.length = 0;
});

function provider(id: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(id, id, "https://example.com/v1", "m");
}

describe("thinking-disabled payloads", () => {
  it("sends reasoning_effort none for Gemini 2.5 and nothing else", async () => {
    await provider("gemini").rewrite(
      {
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.5-flash-lite",
      },
      "key",
      SYSTEM,
      USER,
    );
    const body = captured[0] as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("thought");
    expect(body).not.toHaveProperty("extra_body");
    // Prompts pass through untouched — "thoughtful" must survive.
    const messages = body.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toBe(SYSTEM);
    expect(messages[1]?.content).toBe(USER);
  });

  it("suppresses thought summaries for Gemini 3.x without reasoning_effort", async () => {
    await provider("gemini").rewrite(
      {
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-3.5-flash-lite",
      },
      "key",
      SYSTEM,
      USER,
    );
    const body = captured[0] as Record<string, unknown>;
    expect(body.extra_body).toEqual({
      google: { thinking_config: { include_thoughts: false } },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("thought");
  });

  it("sends reasoning_effort none for OpenAI and no Gemini flags", async () => {
    await provider("openai").rewrite(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      "key",
      SYSTEM,
      USER,
    );
    const body = captured[0] as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("extra_body");
  });

  it("sends no thinking flags for other providers", async () => {
    await provider("custom").rewrite(
      { provider: "custom", baseUrl: "https://example.com/v1", model: "m" },
      "key",
      SYSTEM,
      USER,
    );
    const body = captured[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("extra_body");
  });
});

describe("keyless loopback (Ollama, LM Studio)", () => {
  const local = { provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5" };

  it("rewrites without a key and omits the Authorization header", async () => {
    const out = await provider("ollama").rewrite(local, "", SYSTEM, USER);
    expect(out).toBe("done");
    expect(capturedReqs[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(capturedReqs[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("lists models without a key on loopback", async () => {
    // Mock body is a choices payload (no model list inside); the point is it
    // resolves instead of throwing no-key, against the right URL.
    await expect(provider("ollama").listModels(local, "")).resolves.toEqual(["choices"]);
    expect(capturedReqs[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(capturedReqs[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("still requires a key off loopback", async () => {
    await expect(
      provider("openai").rewrite({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m" }, "", SYSTEM, USER),
    ).rejects.toMatchObject({ kind: "no-key" });
    await expect(
      provider("openai").listModels({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "m" }, ""),
    ).rejects.toMatchObject({ kind: "no-key" });
  });

  it("sends Bearer auth when a key is set, even on loopback", async () => {
    await provider("ollama").rewrite(local, "secret", SYSTEM, USER);
    expect(capturedReqs[0]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });
});
