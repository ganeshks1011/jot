import { beforeEach, describe, expect, it, vi } from "vitest";

function makeArea() {
  const store: Record<string, unknown> = {};
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
    },
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

const relayCalls: Array<{ url: string; method?: string; body?: string }> = [];
let queued: Array<{ ok: boolean; status: number; text: string } | Error> = [];

vi.mock("./net", () => ({
  relayFetch: async (req: { url: string; method?: string; body?: string }) => {
    relayCalls.push(req);
    const next = queued.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no queued relay response");
    return next;
  },
}));

import { getCodevuQuota, rewriteViaCodevu } from "./codevu";
import { ProviderError } from "./providers";

beforeEach(() => {
  relayCalls.length = 0;
  queued = [];
});

function jsonQuota(used: number) {
  return {
    ok: true,
    status: 200,
    text: JSON.stringify({ ok: true, quota: { used, limit: 100, resetsAt: "2026-11-01T07:00:00.000Z" } }),
  };
}

describe("rewriteViaCodevu", () => {
  it("posts installId and text to the codevu rewrite endpoint", async () => {
    queued.push({ ok: true, status: 200, text: JSON.stringify({ ok: true, rewrite: "Polished" }) });
    const chunks: string[] = [];
    const out = await rewriteViaCodevu("rough", "", (d) => chunks.push(d));
    expect(out).toBe("Polished");
    expect(chunks).toEqual(["Polished"]);
    const call = relayCalls[0]!;
    expect(call.url).toBe("https://codevu.com/api/jot/v1/rewrite");
    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body.text).toBe("rough");
    expect(typeof body.installId).toBe("string");
    expect("style" in body).toBe(false);
  });

  it("sends a non-empty style", async () => {
    queued.push({ ok: true, status: 200, text: JSON.stringify({ ok: true, rewrite: "x" }) });
    await rewriteViaCodevu("rough", "professional");
    const body = JSON.parse(relayCalls[0]!.body!) as Record<string, unknown>;
    expect(body.style).toBe("professional");
  });

  it("maps 429 to a quota error", async () => {
    queued.push({ ok: false, status: 429, text: JSON.stringify({ error: "quota_exceeded" }) });
    const err = await rewriteViaCodevu("rough", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "quota" });
  });

  it("maps relay failures to a network error", async () => {
    queued.push(new Error("boom"));
    await expect(rewriteViaCodevu("rough", "")).rejects.toMatchObject({ kind: "network" });
  });

  it("rejects blank rewrites as empty", async () => {
    queued.push({ ok: true, status: 200, text: JSON.stringify({ ok: true, rewrite: "  " }) });
    await expect(rewriteViaCodevu("rough", "")).rejects.toMatchObject({ kind: "empty" });
  });
});

describe("getCodevuQuota", () => {
  it("returns the quota when the backend responds", async () => {
    queued.push(jsonQuota(3));
    const quota = await getCodevuQuota();
    expect(quota).toMatchObject({ used: 3, limit: 100 });
    expect(relayCalls[0]!.url).toContain("/api/jot/v1/quota?installId=");
  });

  it("returns null when unreachable", async () => {
    queued.push(new Error("offline"));
    expect(await getCodevuQuota()).toBeNull();
  });

  it("returns null on a bad payload", async () => {
    queued.push({ ok: true, status: 200, text: "not json" });
    expect(await getCodevuQuota()).toBeNull();
  });
});
