import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayFetch } from "../net";
import { GROK_ADAPTER } from "./registry";

vi.mock("../net", () => ({
  relayFetch: vi.fn(),
}));

const relayFetchMock = vi.mocked(relayFetch);

const SYSTEM = "Rewrite clearly";
const USER = "hello world";

function chatOk(text: string): string {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

beforeEach(() => {
  relayFetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("GROK_ADAPTER", () => {
  it("carries the xAI endpoint, cheapest model, and key page", () => {
    expect(GROK_ADAPTER.id).toBe("grok");
    expect(GROK_ADAPTER.label).toBe("Grok");
    expect(GROK_ADAPTER.defaultBaseUrl).toBe("https://api.x.ai/v1");
    expect(GROK_ADAPTER.defaultModel).toBe("grok-4.3");
    expect(GROK_ADAPTER.apiKeyUrl).toBe("https://console.x.ai");
  });

  it("posts OpenAI-compatible chat completions with a Bearer key", async () => {
    relayFetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: chatOk("done") });
    const out = await GROK_ADAPTER.rewrite(
      { provider: "grok", baseUrl: "https://api.x.ai/v1", model: "grok-4.3" },
      "xai-key",
      SYSTEM,
      USER,
    );
    expect(out).toBe("done");

    const req = relayFetchMock.mock.calls[0]?.[0];
    expect(req?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(req?.method).toBe("POST");
    expect(req?.headers).toMatchObject({ Authorization: "Bearer xai-key" });

    const body = JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("grok-4.3");
    expect(body.messages).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ]);
    expect(body.max_tokens).toBe(1024);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("extra_body");
  });
});
