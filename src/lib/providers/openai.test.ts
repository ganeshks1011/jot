import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai";

const captured: Array<Record<string, unknown>> = [];

vi.mock("../net", () => ({
  relayFetch: vi.fn(async (req: { body?: string }) => {
    captured.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({ choices: [{ message: { content: "done" } }] }),
    };
  }),
}));

const SYSTEM = "Be thoughtful and concise";
const USER = "A thoughtful rewrite please";

beforeEach(() => {
  captured.length = 0;
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
