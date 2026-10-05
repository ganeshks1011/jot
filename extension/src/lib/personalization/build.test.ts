import { describe, expect, it, vi } from "vitest";

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

import { buildApiPrompts, buildDirectPrompts, buildPreviewPrompts, saveDomains, savePrompt } from "./index";

describe("buildDirectPrompts", () => {
  it("uses the default instruction with empty storage", async () => {
    const { system, user } = await buildDirectPrompts({ source: "hello there" });
    expect(system).toContain("ACTIVE MODE:");
    expect(system).toContain("Write clearly, naturally, and concisely");
    expect(system).not.toContain("{mode_instruction}");
    expect(user).toBe("<user_input>\nhello there\n</user_input>");
  });

  it("keeps feedback in the user message and input raw", async () => {
    const { system, user } = await buildDirectPrompts({
      source: "please fix this",
      followUp: "shorter",
    });
    expect(user).toContain("<feedback>\nshorter\n</feedback>");
    expect(user).toContain("<user_input>\nplease fix this\n</user_input>");
    expect(system).not.toContain("<feedback>");
  });

  it("appends the previous rewrite after the input when tweaking", async () => {
    const { user } = await buildDirectPrompts({
      source: "please fix this",
      followUp: "shorter",
      priorOutput: "old rewrite",
    });
    expect(user).toContain("<user_input>\nplease fix this\n</user_input>");
    expect(user).toContain("<previous_rewrite>\nold rewrite\n</previous_rewrite>");
    expect(user.indexOf("<user_input>")).toBeLessThan(user.indexOf("<previous_rewrite>"));
  });

  it("surfaces a saved site override", async () => {
    await savePrompt("email", "Email voice");
    await saveDomains([{ context: "email", pattern: "gmail.com" }]);
    const { system } = await buildDirectPrompts({
      source: "hi",
      site: "gmail.com",
    });
    expect(system).toContain("Email voice");
  });

  it("appends the placeholder guard when opted in", async () => {
    const { system } = await buildDirectPrompts({
      source: "hi",
      preservePlaceholders: true,
    });
    expect(system).toContain("Preserve every placeholder exactly as written");
  });

  it("includes the HTML fragment ahead of plain input when present", async () => {
    const { user } = await buildDirectPrompts({
      source: "hi there",
      sourceHtml: "<p>hi <b>there</b></p>",
    });
    expect(user).toContain("<user_input_html>\n<p>hi <b>there</b></p>\n</user_input_html>");
    expect(user).toContain("<user_input>\nhi there\n</user_input>");
  });
});

describe("buildApiPrompts", () => {
  it("sends exactly systemPrompt + input", async () => {
    const payload = await buildApiPrompts({ source: "hello there" });
    expect(Object.keys(payload).sort()).toEqual(["input", "systemPrompt"]);
    expect(payload.input).toBe("hello there");
    expect(payload.systemPrompt).toContain("ACTIVE MODE:");
  });

  it("folds followUp into the system prompt and keeps input raw", async () => {
    const payload = await buildApiPrompts({
      source: "please fix this",
      followUp: "shorter",
    });
    expect(payload.input).toBe("please fix this");
    expect(payload.systemPrompt).toContain("shorter");
    expect(payload.systemPrompt).toContain("<feedback>");
    expect(payload.input).not.toContain("<feedback>");
    expect(payload.input).not.toContain("<user_input>");
  });

  it("passes priorOutput through and omits the key when absent", async () => {
    const withPrior = await buildApiPrompts({ source: "hi", priorOutput: "  old rewrite  " });
    expect(withPrior.priorOutput).toBe("old rewrite");
    const without = await buildApiPrompts({ source: "hi" });
    expect("priorOutput" in without).toBe(false);
  });

  it("never includes legacy alias keys", async () => {
    const payload = await buildApiPrompts({
      source: "hey",
      followUp: "warmer",
      site: "gmail.com",
    });
    const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    for (const legacy of [
      "mode",
      "text",
      "personalization",
      "customPrompt",
      "instruction",
      "feedback",
      "tweakInstruction",
      "websitePersonality",
    ]) {
      expect(raw).not.toHaveProperty(legacy);
    }
  });

  it("sends the HTML fragment as input when formatting is present", async () => {
    const payload = await buildApiPrompts({
      source: "hi there",
      sourceHtml: "<p>hi <b>there</b></p>",
    });
    expect(payload.input).toBe("<p>hi <b>there</b></p>");
  });
});

describe("write isolation", () => {
  it("writes only the snapshot key, never legacy keys", async () => {
    await savePrompt("email", "Email voice");
    await saveDomains([{ context: "email", pattern: "gmail.com" }]);
    const { browser } = await import("wxt/browser");
    const all = await browser.storage.sync.get([
      "jot:personalization",
      "jot:customModePrompt",
      "jot:sitePrompts",
      "jot:contextPrompts",
      "jot:contextDomains",
    ]);
    expect(Object.keys(all)).toEqual(["jot:personalization"]);
  });
});

describe("buildPreviewPrompts", () => {
  it("uses an explicit instruction verbatim (onboarding preview)", async () => {
    const { system, user } = await buildPreviewPrompts("Sound like a pirate", "hello");
    expect(system).toContain("Sound like a pirate");
    expect(user).toBe("<user_input>\nhello\n</user_input>");
  });

  it("falls back when the instruction is blank", async () => {
    const { system } = await buildPreviewPrompts("   ", "hello");
    expect(system).toContain("Rewrite the text in a clear, natural");
  });
});
