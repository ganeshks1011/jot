import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENGAGEMENT_TIME_MSEC,
  resolveSessionId,
  SESSION_EXPIRATION_MS,
  type SessionData,
  type SessionStore,
} from "./session";

function memoryStore(initial: SessionData | null = null): SessionStore & { saved: SessionData | null } {
  let current = initial;
  const box: SessionStore & { saved: SessionData | null } = {
    get saved() {
      return current;
    },
    set saved(_: SessionData | null) {},
    get: async () => current,
    set: async (data: SessionData) => {
      current = data;
    },
  };
  return box;
}

describe("resolveSessionId", () => {
  it("creates a timestamp session when none exists", async () => {
    const store = memoryStore(null);
    const id = await resolveSessionId(store, 1_000_000);
    expect(id).toBe("1000000");
    expect(store.saved).toEqual({ session_id: "1000000", timestamp: 1_000_000 });
  });

  it("refreshes the timestamp within the window and keeps the id", async () => {
    const store = memoryStore({ session_id: "abc", timestamp: 1_000_000 });
    const id = await resolveSessionId(store, 1_000_000 + SESSION_EXPIRATION_MS - 1);
    expect(id).toBe("abc");
    expect(store.saved?.timestamp).toBe(1_000_000 + SESSION_EXPIRATION_MS - 1);
  });

  it("rotates after 30 minutes of inactivity", async () => {
    const store = memoryStore({ session_id: "old", timestamp: 1_000_000 });
    const id = await resolveSessionId(store, 1_000_000 + SESSION_EXPIRATION_MS + 1);
    expect(id).toBe(String(1_000_000 + SESSION_EXPIRATION_MS + 1));
    expect(id).not.toBe("old");
  });

  it("replaces corrupt stored data with a fresh session", async () => {
    const store = memoryStore({ session_id: "", timestamp: NaN });
    const id = await resolveSessionId(store, 5_000);
    expect(id).toBe("5000");
  });

  it("still returns an id when the store throws", async () => {
    const failing: SessionStore = {
      get: async () => {
        throw new Error("denied");
      },
      set: async () => {
        throw new Error("denied");
      },
    };
    await expect(resolveSessionId(failing, 7_000)).resolves.toBe("7000");
  });

  it("exports the guide default engagement value", () => {
    expect(DEFAULT_ENGAGEMENT_TIME_MSEC).toBe(100);
  });
});
