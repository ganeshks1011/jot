import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { isRelayUrlAllowed } from "@/lib/net";

/**
 * On-demand page access. Jot declares no host permissions and no persistent
 * content scripts; the only path into a web page is below:
 *
 *   user invokes Jot (chrome.commands shortcut or action click)
 *     -> activeTab grants temporary access to the active tab
 *     -> chrome.scripting.executeScript injects jot-host.js (once)
 *     -> the injected controller captures text / inserts results
 *     -> closing the overlay tears it down completely
 */

const HOST_FILE = "/jot-host.js";

async function openBlockedNotice(): Promise<void> {
  // Focus an existing notice window instead of stacking duplicates.
  const windows = await browser.windows.getAll({ populate: true });
  const existing = windows.find((w) =>
    w.tabs?.some((t) => typeof t.url === "string" && t.url.includes("jot-blocked.html")),
  );
  if (existing?.id != null) {
    await browser.windows.update(existing.id, { focused: true });
    return;
  }
  await browser.windows.create({
    url: browser.runtime.getURL("/jot-blocked.html"),
    type: "popup",
    width: 400,
    height: 200,
  });
}

type InvocationMethod = "shortcut" | "context_menu" | "action";

/** Best-effort usage event → backend GA4 proxy. Never throws, never blocks. */
async function reportAnalyticsEvent(envelope: {
  event: unknown;
  params?: unknown;
  installId?: unknown;
  ts?: unknown;
}): Promise<void> {
  try {
    const [
      { getAnalyticsEnabled, getInstallId },
      { isAnalyticsEvent, sanitizeParams, getOrCreateSessionId, DEFAULT_ENGAGEMENT_TIME_MSEC },
    ] = await Promise.all([import("@/lib/storage"), import("@/lib/analytics")]);
    if (!(await getAnalyticsEnabled())) return;
    if (!isAnalyticsEvent(envelope.event)) return;
    let installId = typeof envelope.installId === "string" ? envelope.installId : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installId)) {
      installId = await getInstallId();
    }
    const ts = typeof envelope.ts === "number" && Number.isFinite(envelope.ts) ? envelope.ts : Date.now();
    const clean = sanitizeParams(envelope.params as never);
    const session_id = await getOrCreateSessionId().catch(() => String(Date.now()));
    // engagement_time_msec keeps events visible in GA standard reports:
    // measured durations win, otherwise the guide default.
    const engagement_time_msec =
      typeof clean.duration_ms === "number" ? clean.duration_ms : DEFAULT_ENGAGEMENT_TIME_MSEC;
    const { WURKFLO_ORIGIN } = await import("@/lib/config");
    await fetch(`${WURKFLO_ORIGIN}/api/jot/analytics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [{ event: envelope.event, params: { ...clean, session_id, engagement_time_msec }, installId, ts }],
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics must never break the background worker.
  }
}

function tabHostname(tab: { url?: string } | undefined): string | undefined {
  try {
    const url = tab?.url ?? "";
    if (!url) return undefined;
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

async function activateJot(invocation: InvocationMethod): Promise<void> {
  let tabId: number | undefined;
  let tabUrl: string | undefined;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    tabUrl = tab?.url;
  } catch {
    return;
  }
  if (tabId == null) return;

  // Gate: provider must be configured (Step 2 non-skippable). If not ready, open onboarding instead of injecting.
  try {
    const { getBackendConfig, getApiKey, getWurkfloUser } = await import("@/lib/storage");
    const [cfg, wurkUser] = await Promise.all([getBackendConfig(), getWurkfloUser()]);
    let isReady = false;
    if (cfg.provider === "jot-api") isReady = !!wurkUser;
    else {
      const lower = (cfg.baseUrl ?? "").toLowerCase();
      if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("::1")) isReady = true;
      else isReady = !!(await getApiKey(cfg.provider)).trim();
    }
    if (!isReady) {
      await browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
      return;
    }
  } catch {
    // If the readiness check itself fails (e.g. storage unavailable),
    // fail closed: do not inject into the page.
    return;
  }

  // Fast path: a live controller in this tab toggles itself closed.
  try {
    await browser.tabs.sendMessage(tabId, { type: "TOGGLE_OVERLAY" });
    return;
  } catch {
    // No receiver - either never injected or torn down after close. Inject.
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [HOST_FILE],
    });
    const { siteLabelFor } = await import("@/lib/analytics");
    void reportAnalyticsEvent({
      event: "jot_opened",
      params: { site: siteLabelFor(tabHostname({ url: tabUrl })), invocation_method: invocation },
    });
  } catch {
    // Chrome blocks scripting on its own pages, the Web Store, etc. Never
    // surface raw permission errors and never suggest granting site access.
    void openBlockedNotice().catch(() => {});
  }
}

function setupContextMenu(): void {
  void browser.contextMenus.removeAll().then(() => {
    void browser.contextMenus.create({
      id: "open-jot",
      title: "Rewrite with Jot",
      contexts: ["editable", "selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
}

export default defineBackground(() => {
  // Kind-only crash signal: no message, no stack. Those can carry user
  // content. The event name alone tells us an error happened.
  addEventListener("unhandledrejection", () => {
    void reportAnalyticsEvent({ event: "extension_error", params: {} });
  });
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void browser.storage.sync.set({ ["jot:onboarded"]: false });
      void browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
      void reportAnalyticsEvent({ event: "extension_installed", params: {} });
    } else if (details.reason === "update") {
      void reportAnalyticsEvent({ event: "extension_updated", params: {} });
    }
    setupContextMenu();
  });
  // Re-create on startup (service worker may restart without onInstalled)
  if (browser.runtime.onStartup) {
    browser.runtime.onStartup.addListener(() => setupContextMenu());
  }
  // Ensure menu exists when background starts (MV3 service worker lifecycle)
  setupContextMenu();

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === "open-jot") {
      void reportAnalyticsEvent({ event: "context_menu_used", params: {} });
      void activateJot("context_menu");
    }
  });

  browser.commands.onCommand.addListener((command) => {
    if (command !== "toggle-jot") return;
    void reportAnalyticsEvent({ event: "shortcut_used", params: {} });
    void activateJot("shortcut");
  });

  browser.action.onClicked.addListener(() => {
    void activateJot("action");
  });

  interface HttpMessage {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  }

  browser.runtime.onMessage.addListener((message: unknown, sender: { id?: string }) => {
    // Only this extension's own contexts (overlay, options, content script)
    // may use the privileged relays below. Web pages cannot reach runtime
    // messages (no externally_connectable), so a foreign sender id means a
    // compromised or spoofed caller. Refuse silently.
    if (sender?.id !== browser.runtime.id) return undefined;
    const type = (message as { type?: unknown } | null | undefined)?.type;

    // Analytics relay: overlay/options report usage; the service worker
    // forwards to the backend GA4 proxy (secret stays server-side).
    if (type === "jot:analytics" && message && typeof message === "object") {
      const m = message as { event?: unknown; params?: unknown; installId?: unknown; ts?: unknown };
      void reportAnalyticsEvent({ event: m.event, params: m.params, installId: m.installId, ts: m.ts });
      return { ok: true };
    }

    // HTTP relay: extension pages are CORS-bound (Jot has no host
    // permissions); service-worker fetches are not.
    if (type === "jot:http" && message && typeof message === "object") {
      return handleHttpRelay(message as HttpMessage);
    }

    // Wurkflo token authority: the persisted session (lib/session.ts,
    // chrome.storage.local) is readable here; the partitioned overlay
    // iframe asks for a fresh ID token per rewrite.
    if (type === "jot:wurkflo-token") {
      return (async () => {
        const { getSessionIdToken } = await import("@/lib/session");
        const token = await getSessionIdToken();
        return { ok: true as const, token };
      })().catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : "not-signed-in",
      }));
    }
  });
  async function handleHttpRelay(message: HttpMessage) {
    const { url, method, headers, body } = message;
    if (typeof url !== "string" || !url) {
      return { ok: false, error: "bad-request" };
    }
    if (!isRelayUrlAllowed(url)) {
      return { ok: false, error: "insecure-url" };
    }
    try {
      const res = await fetch(url, {
        method: typeof method === "string" ? method : "GET",
        headers: headers && typeof headers === "object" ? (headers as Record<string, string>) : undefined,
        body: typeof body === "string" ? body : undefined,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "network-error",
      };
    }
  }

  /**
   * Streaming relay (Wurkflo SSE). The client opens a `jot:sse` Port, sends
   * one `start` message with the request, and receives raw decoded chunks
   * plus a final done/http-error frame. Disconnecting the port cancels the
   * upstream fetch.
   */
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "jot:sse") return;
    if (port.sender?.id !== browser.runtime.id) {
      try {
        port.disconnect();
      } catch {
        // Already gone.
      }
      return;
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const cleanup = (): void => {
      reader?.cancel().catch(() => {});
      reader = null;
    };

    port.onDisconnect.addListener(cleanup);

    port.onMessage.addListener((message: unknown) => {
      const msg = (message ?? null) as {
        type?: string;
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } | null;
      if (!msg || msg.type !== "start") return;
      const { url } = msg;
      if (typeof url !== "string" || !url) return;
      if (!isRelayUrlAllowed(url)) return;

      void (async () => {
        let res: Response;
        try {
          res = await fetch(url, {
            method: typeof msg.method === "string" ? msg.method : "POST",
            headers: msg.headers,
            body: typeof msg.body === "string" ? msg.body : undefined,
          });
        } catch (err) {
          try {
            port.postMessage({
              type: "error",
              message: err instanceof Error ? err.message : "network-error",
            });
          } catch {
            // Client already gone.
          }
          port.disconnect();
          return;
        }

        const remaining = Number(res.headers.get("X-Jot-Remaining"));
        const remainingValid = Number.isFinite(remaining);
        const promptHash = res.headers.get("X-Jot-Prompt-Hash")?.trim() || "";

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          try {
            port.postMessage({
              type: "http-error",
              status: res.status,
              body,
              ...(remainingValid ? { remaining } : {}),
            });
          } catch {
            // Client already gone.
          }
          port.disconnect();
          return;
        }

        try {
          port.postMessage({
            type: "headers",
            ...(remainingValid ? { remaining } : {}),
            ...(promptHash ? { promptHash } : {}),
          });
        } catch {
          // Ignore - chunks below will fail too if the client vanished.
        }

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            port.postMessage({ type: "chunk", text: decoder.decode(value, { stream: true }) });
          }
          port.postMessage({ type: "done" });
        } catch (err) {
          try {
            port.postMessage({
              type: "error",
              message: err instanceof Error ? err.message : "stream-failed",
            });
          } catch {
            // Client already gone.
          }
        } finally {
          reader = null;
          port.disconnect();
        }
      })();
    });
  });
});
