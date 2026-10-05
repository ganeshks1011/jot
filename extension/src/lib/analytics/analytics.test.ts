import { beforeEach, describe, expect, it, vi } from "vitest";

function makeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
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

const sendMessage = vi.fn();

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { sendMessage: (...args: unknown[]) => sendMessage(...args) },
    storage: {
      sync: makeArea(),
      local: makeArea(),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
}));

import { saveAnalyticsEnabled } from "../storage";
import { isAnalyticsEvent, sanitizeParams, track } from "./index";
import { editorTypeFor, siteLabelFor } from "./site";

beforeEach(() => {
  sendMessage.mockClear();
  sendMessage.mockResolvedValue({ ok: true });
});

describe("siteLabelFor", () => {
  it("maps workspace subdomains to the coarse label, not the raw host", () => {
    expect(siteLabelFor("acme.slack.com")).toBe("slack");
    expect(siteLabelFor("app.slack.com")).toBe("slack");
    expect(siteLabelFor("mail.google.com")).toBe("gmail");
  });

  it("rejects suffix spoofing and unknown hosts", () => {
    expect(siteLabelFor("slack.com.evil.com")).toBe("other");
    expect(siteLabelFor("fakeslack.com")).toBe("other");
    expect(siteLabelFor("intranet.corp")).toBe("other");
  });

  it("handles empty, null, ports, and case", () => {
    expect(siteLabelFor("")).toBe("other");
    expect(siteLabelFor(null)).toBe("other");
    expect(siteLabelFor("GMail.COM:443")).toBe("gmail");
  });
});

describe("editorTypeFor", () => {
  it("maps known field types and defaults unknown", () => {
    expect(editorTypeFor("textarea")).toBe("textarea");
    expect(editorTypeFor("input")).toBe("input");
    expect(editorTypeFor("contenteditable")).toBe("richtext");
    expect(editorTypeFor("selection")).toBe("selection");
    expect(editorTypeFor("weird")).toBe("unknown");
    expect(editorTypeFor(null)).toBe("unknown");
  });
});

describe("sanitizeParams", () => {
  it("drops unknown keys — content can never typecheck or pass through", () => {
    const out = sanitizeParams({
      site: "slack",
      text: "secret message",
      input: "hello",
      user_input: "hi",
    } as unknown as Parameters<typeof sanitizeParams>[0]);
    expect(out).toEqual({ site: "slack" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("clamps and rounds durations, drops non-finite values", () => {
    expect(sanitizeParams({ duration_ms: 123.6 }).duration_ms).toBe(124);
    expect(sanitizeParams({ duration_ms: -5 }).duration_ms).toBe(0);
    expect(sanitizeParams({ duration_ms: NaN })).not.toHaveProperty("duration_ms");
    expect(sanitizeParams({ duration_ms: Infinity })).not.toHaveProperty("duration_ms");
  });

  it("rejects off-vocabulary enum values", () => {
    expect(sanitizeParams({ site: "acme.slack.com" } as never)).not.toHaveProperty("site");
    expect(sanitizeParams({ error_type: "weird" } as never)).not.toHaveProperty("error_type");
  });

  it("passes valid scalars through", () => {
    expect(sanitizeParams({ success: true, error_type: "quota", confirmed: false, duration_ms: 1500 })).toEqual({
      success: true,
      error_type: "quota",
      confirmed: false,
      duration_ms: 1500,
    });
  });

  it("passes page_view params truncated", () => {
    expect(
      sanitizeParams({ page_title: "  Jot Settings  ", page_location: "chrome-extension://abc/options.html" }),
    ).toEqual({ page_title: "Jot Settings", page_location: "chrome-extension://abc/options.html" });
    const long = sanitizeParams({ page_title: "x".repeat(500) });
    expect(long.page_title).toHaveLength(128);
    expect(sanitizeParams({ page_title: "   " })).not.toHaveProperty("page_title");
  });
});

describe("isAnalyticsEvent", () => {
  it("accepts vocabulary events and rejects anything else", () => {
    expect(isAnalyticsEvent("rewrite_started")).toBe(true);
    expect(isAnalyticsEvent("page_view")).toBe(true);
    expect(isAnalyticsEvent("extension_error")).toBe(true);
    expect(isAnalyticsEvent("onboarding_step_viewed")).toBe(true);
    expect(isAnalyticsEvent("onboarding_completed")).toBe(true);
    expect(isAnalyticsEvent("paste_text_here")).toBe(false);
    expect(isAnalyticsEvent(undefined)).toBe(false);
  });
});

describe("provider/model/step params", () => {
  it("passes known providers and truncates models", () => {
    expect(sanitizeParams({ provider: "openai", model: "gpt-4o-mini" })).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(sanitizeParams({ provider: "ollama", model: "qwen2.5" })).toEqual({
      provider: "ollama",
      model: "qwen2.5",
    });
    const long = sanitizeParams({ provider: "openai", model: "x".repeat(500) });
    expect(long.model).toHaveLength(128);
  });

  it("collapses custom slugs and rejects off-vocabulary providers", () => {
    expect(sanitizeParams({ provider: "my-local-llama" } as never).provider).toBe("custom");
    expect(sanitizeParams({ provider: "" } as never).provider).toBeUndefined();
  });

  it("drops model names for custom providers", () => {
    expect(sanitizeParams({ provider: "my-local-llama", model: "secret-paste" } as never)).toEqual({
      provider: "custom",
    });
    expect(sanitizeParams({ model: "sk-live-123" })).toEqual({});
  });

  it("validates funnel position", () => {
    expect(sanitizeParams({ step: 2, step_name: "personalization" })).toEqual({
      step: 2,
      step_name: "personalization",
    });
    expect(sanitizeParams({ step: 99, step_name: "everywhere" } as never)).toEqual({});
    expect(sanitizeParams({ step: 1.5 })).not.toHaveProperty("step");
  });
});

describe("resolveProviderMeta", () => {
  it("resolves known provider and model from backend config", async () => {
    const { saveBackendConfig } = await import("../storage");
    const { resolveProviderMeta } = await import("./provider");
    await saveBackendConfig({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    await expect(resolveProviderMeta()).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("collapses unknown provider ids to custom and drops the model", async () => {
    const { saveBackendConfig } = await import("../storage");
    const { resolveProviderMeta } = await import("./provider");
    await saveBackendConfig({
      provider: "my-local-llama",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
    });
    // Custom model names are user-controlled free text and could contain
    // pasted secrets, so they never leave the device.
    await expect(resolveProviderMeta()).resolves.toEqual({
      provider: "custom",
      model: "",
    });
  });

  it("attributes the ollama builtin with its model", async () => {
    const { saveBackendConfig } = await import("../storage");
    const { resolveProviderMeta } = await import("./provider");
    await saveBackendConfig({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5",
    });
    await expect(resolveProviderMeta()).resolves.toEqual({
      provider: "ollama",
      model: "qwen2.5",
    });
  });
});

describe("track", () => {
  it("emits nothing when opted out", async () => {
    await saveAnalyticsEnabled(false);
    await track("rewrite_started", { site: "slack" });
    expect(sendMessage).not.toHaveBeenCalled();
    await saveAnalyticsEnabled(true);
  });

  it("sends envelope with install id and sanitized params", async () => {
    await saveAnalyticsEnabled(true);
    await track("jot_opened", { site: "slack", invocation_method: "shortcut" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(msg.type).toBe("jot:analytics");
    expect(msg.event).toBe("jot_opened");
    expect(msg.params).toEqual({ site: "slack", invocation_method: "shortcut" });
    expect(msg.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof msg.ts).toBe("number");
  });

  it("rejects unknown event names", async () => {
    await track("exfiltrate_text" as never);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
