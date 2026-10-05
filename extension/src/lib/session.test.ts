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

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
let changeListener: ChangeListener | null = null;

vi.mock("wxt/browser", () => ({
  browser: {
    storage: {
      local: makeArea(),
      onChanged: {
        addListener: (fn: ChangeListener) => {
          changeListener = fn;
        },
        removeListener: () => {
          changeListener = null;
        },
      },
    },
    runtime: { sendMessage: async () => undefined },
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=test-key";

async function freshSession() {
  vi.resetModules();
  return import("./session");
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-key");
  changeListener = null;
  const { browser } = await import("wxt/browser");
  await browser.storage.local.remove("jot:wurkfloSession");
});

describe("signInSession", () => {
  it("persists the session and returns the user", async () => {
    const { signInSession } = await freshSession();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === SIGN_IN_URL) {
        return jsonResponse({ idToken: "id-1", refreshToken: "rt-1", expiresIn: "3600", localId: "uid-1" });
      }
      return jsonResponse({ users: [{ localId: "uid-1", email: "a@x.test" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = await signInSession("custom-1");
    expect(user).toEqual({ uid: "uid-1", email: "a@x.test" });

    const { browser } = await import("wxt/browser");
    const stored = await browser.storage.local.get("jot:wurkfloSession");
    const session = stored["jot:wurkfloSession"] as Record<string, unknown>;
    expect(session.refreshToken).toBe("rt-1");
    expect(session.uid).toBe("uid-1");
    expect(session.idToken).toBe("id-1");
    expect(typeof session.idTokenExpiresAt).toBe("number");
  });

  it("surfaces server errors on bad custom tokens", async () => {
    const { signInSession } = await freshSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "INVALID_CUSTOM_TOKEN" } }, 400)),
    );
    await expect(signInSession("bad")).rejects.toThrow("INVALID_CUSTOM_TOKEN");
  });

  it("clears legacy Firebase IndexedDB state", async () => {
    const deleteDatabase = vi.fn(() => {
      const req = {} as IDBOpenDBRequest;
      queueMicrotask(() => req.onsuccess?.(new Event("success")));
      return req;
    });
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "firebaseLocalStorageDb" }, { name: "other" }],
      deleteDatabase,
    });
    const { signInSession } = await freshSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === SIGN_IN_URL
          ? jsonResponse({ idToken: "id-1", refreshToken: "rt-1", expiresIn: "3600", localId: "u" })
          : jsonResponse({ users: [] }),
      ),
    );
    await signInSession("custom-1");
    expect(deleteDatabase).toHaveBeenCalledWith("firebaseLocalStorageDb");
    expect(deleteDatabase).not.toHaveBeenCalledWith("other");
  });
});

describe("signInSession VerifyCustomTokenResponse shape", () => {
  const jwt = (claims: Record<string, unknown>): string => {
    const b64 = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
  };

  it("derives the uid from the ID token when localId is absent", async () => {
    const { signInSession, uidFromIdToken } = await freshSession();
    const idToken = jwt({ user_id: "uid-jwt", sub: "uid-jwt" });
    expect(uidFromIdToken(idToken)).toBe("uid-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === SIGN_IN_URL
          ? jsonResponse({
              kind: "identitytoolkit#VerifyCustomTokenResponse",
              idToken,
              refreshToken: "rt-1",
              expiresIn: "3600",
              isNewUser: false,
            })
          : jsonResponse({ users: [{ localId: "uid-jwt", email: "a@x.test" }] }),
      ),
    );
    const user = await signInSession("custom-1");
    expect(user).toEqual({ uid: "uid-jwt", email: "a@x.test" });
  });

  it("throws a diagnosable error when no uid is present", async () => {
    const { signInSession } = await freshSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          kind: "identitytoolkit#VerifyCustomTokenResponse",
          idToken: "not-a-jwt",
          refreshToken: "rt-1",
          expiresIn: "3600",
        }),
      ),
    );
    await expect(signInSession("custom-1")).rejects.toThrow("no uid in response");
  });

  it("uidFromIdToken reads sub fallback and rejects garbage", async () => {
    const { uidFromIdToken } = await freshSession();
    expect(uidFromIdToken(jwt({ sub: "uid-sub" }))).toBe("uid-sub");
    expect(uidFromIdToken("garbage")).toBeNull();
    expect(uidFromIdToken(jwt({}))).toBeNull();
  });
});

describe("getSessionIdToken", () => {
  it("throws not-signed-in with no session", async () => {
    const { getSessionIdToken } = await freshSession();
    await expect(getSessionIdToken()).rejects.toThrow("not-signed-in");
  });

  it("returns the cached token without network when fresh", async () => {
    const { signInSession, getSessionIdToken } = await freshSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === SIGN_IN_URL
          ? jsonResponse({ idToken: "id-1", refreshToken: "rt-1", expiresIn: "3600", localId: "u" })
          : jsonResponse({ users: [] }),
      ),
    );
    await signInSession("custom-1");

    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSessionIdToken()).resolves.toBe("id-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and rotates persistence", async () => {
    const mod = await freshSession();
    const { browser } = await import("wxt/browser");
    await browser.storage.local.set({
      "jot:wurkfloSession": {
        refreshToken: "rt-old",
        uid: "u",
        email: null,
        idToken: "id-old",
        idTokenExpiresAt: Date.now() - 1000,
      },
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id_token: "id-new", refresh_token: "rt-new", expires_in: "3600", user_id: "u" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(mod.getSessionIdToken()).resolves.toBe("id-new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = (await browser.storage.local.get("jot:wurkfloSession"))["jot:wurkfloSession"] as Record<
      string,
      unknown
    >;
    expect(stored.idToken).toBe("id-new");
    expect(stored.refreshToken).toBe("rt-new");
  });

  it("clears state and reports not-signed-in on dead refresh tokens", async () => {
    const mod = await freshSession();
    const { browser } = await import("wxt/browser");
    await browser.storage.local.set({
      "jot:wurkfloSession": {
        refreshToken: "rt-dead",
        uid: "u",
        email: null,
        idToken: "id-old",
        idTokenExpiresAt: Date.now() - 1000,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "INVALID_REFRESH_TOKEN" } }, 400)),
    );
    await expect(mod.getSessionIdToken()).rejects.toThrow("not-signed-in");
    const stored = await browser.storage.local.get("jot:wurkfloSession");
    expect(stored["jot:wurkfloSession"]).toBeUndefined();
  });
});

describe("signOutSession", () => {
  it("revokes server-side and clears local state", async () => {
    const mod = await freshSession();
    const { browser } = await import("wxt/browser");
    await browser.storage.local.set({
      "jot:wurkfloSession": {
        refreshToken: "rt-1",
        uid: "u",
        email: null,
        idToken: "id-1",
        idTokenExpiresAt: Date.now() + 3600_000,
      },
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mod.signOutSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("https://oauth2.googleapis.com/revoke");
    const stored = await browser.storage.local.get("jot:wurkfloSession");
    expect(stored["jot:wurkfloSession"]).toBeUndefined();
  });
});

describe("watchSession", () => {
  it("maps session changes to users and ignores other keys", async () => {
    const { watchSession } = await freshSession();
    const seen: Array<{ uid: string; email: string | null } | null> = [];
    const unsub = watchSession((user) => seen.push(user));
    expect(changeListener).not.toBeNull();

    changeListener?.({ "jot:other": { newValue: 1 } }, "local");
    changeListener?.({ "jot:wurkfloSession": { newValue: { uid: "u", email: "a@x.test" } } }, "local");
    changeListener?.({ "jot:wurkfloSession": { newValue: undefined } }, "local");
    expect(seen).toEqual([{ uid: "u", email: "a@x.test" }, null]);

    unsub();
    expect(changeListener).toBeNull();
  });
});

describe("missing API key", () => {
  it("fails fast with an actionable message", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
    const { signInSession } = await freshSession();
    await expect(signInSession("custom-1")).rejects.toThrow("VITE_FIREBASE_API_KEY");
  });
});
