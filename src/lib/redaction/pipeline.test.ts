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

const captured: Array<{ system: string; user: string }> = [];

vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers")>();
  return {
    ...actual,
    getAdapter: () => ({
      id: "openai",
      label: "OpenAI",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
      tiersEnforcedServerSide: false,
      rewrite: async (_config: unknown, _apiKey: string, system: string, user: string) => {
        captured.push({ system, user });
        // Echo any placeholders from the request so restore is exercised.
        const placeholders = [...new Set([...user.matchAll(/\[[A-Z]+_\d+\]/g)].map((m) => m[0]))];
        return placeholders.length ? `Hi ${placeholders.join(" ")}, noted.` : "Hi [EMAIL_1], noted.";
      },
      listModels: async () => [],
    }),
  };
});

import { rewriteText } from "../api";
import { saveDomains, savePrompt } from "../personalization";
import { saveBackendConfig, saveRedactionEnabled, saveRedactNamesEnabled } from "../storage";

beforeEach(async () => {
  captured.length = 0;
  await saveBackendConfig({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  });
  await saveRedactionEnabled(true);
});

describe("redacted rewrite pipeline", () => {
  it("sends redacted text and restores the result", async () => {
    const out = await rewriteText("Contact john@acme.com");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.user).toContain("[EMAIL_1]");
    expect(captured[0]?.user).not.toContain("john@acme.com");
    expect(out).toBe("Hi john@acme.com, noted.");
  });

  it("instructs the model to preserve placeholders", async () => {
    await rewriteText("Contact john@acme.com");
    expect(captured[0]?.system).toContain("Preserve every placeholder exactly as written");
  });

  it("redacts follow-up tweaks with shared numbering", async () => {
    await rewriteText("Email john@acme.com", undefined, "cc john@acme.com");
    const user = captured[0]?.user ?? "";
    expect(user).not.toContain("john@acme.com");
    // Same value in source and tweak shares one placeholder.
    expect(user.match(/\[EMAIL_1\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(user).not.toContain("[EMAIL_2]");
  });

  it("sends the original text when the setting is disabled", async () => {
    await saveRedactionEnabled(false);
    const out = await rewriteText("Contact john@acme.com");
    expect(captured[0]?.user).toContain("john@acme.com");
    expect(captured[0]?.system).not.toContain("Preserve every placeholder");
    expect(out).toBe("Hi [EMAIL_1], noted.");
  });

  it("redacts person names when the names setting is enabled", async () => {
    await saveRedactNamesEnabled(true);
    const out = await rewriteText("ping Sarah Jones about standup");
    expect(captured[0]?.user).toContain("[NAME_1]");
    expect(captured[0]?.user).not.toContain("Sarah Jones");
    expect(out).toContain("Sarah Jones");
    await saveRedactNamesEnabled(false);
  });

  it("redacts tagged usernames before the LLM and restores after", async () => {
    const out = await rewriteText("@Byte - status update?");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.user).toContain("[MENTION_1]");
    expect(captured[0]?.user).not.toContain("@Byte");
    expect(captured[0]?.system).toContain("Preserve every placeholder exactly as written");
    expect(out).toContain("@Byte");
    expect(out).not.toContain("[MENTION_1]");
  });

  it("applies a saved site style to the rewrite", async () => {
    await savePrompt("email", "Email voice");
    await saveDomains([{ context: "email", pattern: "gmail.com" }]);
    await rewriteText("hello there", "gmail.com");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.system).toContain("Email voice");
  });
});
