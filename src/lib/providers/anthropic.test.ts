import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayFetch } from "../net";
import { AnthropicProvider } from "./anthropic";

vi.mock("../net", () => ({
  relayFetch: vi.fn(),
}));

const relayFetchMock = vi.mocked(relayFetch);

const SYSTEM = "Rewrite clearly";
const USER = "hello world";

function nativeOk(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

beforeEach(() => {
  relayFetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("AnthropicProvider rewrite", () => {
  it("posts native messages shape with x-api-key headers", async () => {
    relayFetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: nativeOk("done") });
    const provider = new AnthropicProvider();
    const out = await provider.rewrite(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5" },
      "sk-ant-key",
      SYSTEM,
      USER,
    );
    expect(out).toBe("done");

    const req = relayFetchMock.mock.calls[0]?.[0];
    expect(req?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req?.method).toBe("POST");
    expect(req?.headers).toMatchObject({
      "x-api-key": "sk-ant-key",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(req?.headers).not.toHaveProperty("Authorization");

    const body = JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.system).toBe(SYSTEM);
    expect(body.messages).toEqual([{ role: "user", content: USER }]);
    expect(body.max_tokens).toBe(1024);
  });

  it("tolerates legacy base URLs ending in /v1", async () => {
    relayFetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: nativeOk("done") });
    const provider = new AnthropicProvider();
    await provider.rewrite(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
      "key",
      SYSTEM,
      USER,
    );
    expect(relayFetchMock.mock.calls[0]?.[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("joins text blocks and maps auth failures", async () => {
    relayFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    });
    const provider = new AnthropicProvider();
    await expect(
      provider.rewrite(
        { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
        "key",
        SYSTEM,
        USER,
      ),
    ).resolves.toBe("ab");

    relayFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: JSON.stringify({ error: { message: "invalid x-api-key" } }),
    });
    await expect(
      provider.rewrite(
        { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
        "bad",
        SYSTEM,
        USER,
      ),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("falls back to direct browser fetch when the relay is unreachable", async () => {
    relayFetchMock.mockRejectedValueOnce(new Error("relay-failed"));
    const directText = nativeOk("via-browser");
    const fetchMock = vi.fn(async () => new Response(directText, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider();
    const out = await provider.rewrite(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
      "key",
      SYSTEM,
      USER,
    );
    expect(out).toBe("via-browser");
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit?];
    const init = firstCall?.[1];
    expect((init?.headers as Record<string, string>)["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
});

describe("AnthropicProvider listModels", () => {
  it("loads ids from native /v1/models", async () => {
    relayFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-5" }] }),
    });
    const provider = new AnthropicProvider();
    const models = await provider.listModels(
      { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "m" },
      "key",
    );
    expect(models).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
    expect(relayFetchMock.mock.calls[0]?.[0]?.url).toBe("https://api.anthropic.com/v1/models");
  });
});
