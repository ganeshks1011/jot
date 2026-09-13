import { browser } from "wxt/browser";
import { isTransientRelayError, isTransientRelayMessage } from "./transientErrors";

/**
 * HTTP access for extension-page contexts (overlay iframe, options page).
 *
 * Jot declares no host permissions, so its extension pages are subject to
 * normal CORS - which many model providers (Anthropic, Ollama, self-hosted
 * endpoints) do not allow. The background service worker is not CORS-bound,
 * so every request is relayed through it: plain request/response via
 * `runtime.sendMessage` and streaming responses via a dedicated Port.
 * No webpage content passes through this layer beyond the rewrite text the
 * caller explicitly sends to the configured provider.
 */

export interface RelayHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RelayHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** Loopback hosts where plaintext HTTP is legitimate (local model servers). */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Loopback URLs (Ollama, LM Studio). Unparseable input is never loopback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Relay URL allowlist (enforced by the background service worker for both
 * the request/response and streaming relays). Https anywhere: custom
 * providers use arbitrary hosts, including unsaved on-screen overrides the
 * relay cannot resolve against storage. Plaintext http for loopback
 * servers (Ollama, LM Studio) only. Keeps API keys off the wire in
 * cleartext without breaking local setups.
 */
export function isRelayUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Request/response relay through the background service worker. */
export async function relayFetch(req: RelayHttpRequest): Promise<RelayHttpResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = (await browser.runtime.sendMessage({
        type: "jot:http",
        ...req,
      })) as (Partial<RelayHttpResponse> & { error?: string }) | undefined;

      if (!res || typeof res.status !== "number" || typeof res.text !== "string") {
        const errMsg = res?.error ?? "relay-failed";
        if (attempt === 0 && isTransientRelayMessage(errMsg)) {
          await sleep(350);
          continue;
        }
        throw new Error(errMsg);
      }
      return { ok: res.ok === true, status: res.status, text: res.text };
    } catch (err) {
      if (attempt === 0 && isTransientRelayError(err)) {
        await sleep(350);
        continue;
      }
      throw err;
    }
  }
  throw new Error("relay-failed");
}

export interface RelayStreamHandlers {
  /** Raw decoded bytes as they arrive (SSE frames are parsed by the caller). */
  onChunk: (raw: string) => void;
  /** Named response headers surfaced by the worker (e.g. X-Jot-Remaining). */
  onRemaining?: (remaining: number) => void;
  /** Value of the X-Jot-Prompt-Hash response header, when present. */
  onPromptHash?: (hash: string) => void;
}

/**
 * Streaming relay through a `jot:sse` Port. Resolves when the background
 * finishes the stream (`done`), rejects on transport/HTTP errors. An aborted
 * `signal` rejects with an AbortError DOMException after disconnecting the
 * port (which cancels the fetch inside the worker).
 */
export function relayStream(req: RelayHttpRequest, handlers: RelayStreamHandlers, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let gotHeaders = false;
    let gotChunk = false;
    let gotDone = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const port = browser.runtime.connect({ name: "jot:sse" });

    const onAbort = (): void => {
      try {
        port.disconnect();
      } catch {
        // Already disconnected by the other end.
      }
      finish(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(new DOMException("Aborted", "AbortError"));
      try {
        port.disconnect();
      } catch {}
      return;
    }

    interface PortMessage {
      type?: string;
      text?: string;
      remaining?: number;
      promptHash?: string;
      status?: number;
      body?: string;
      message?: string;
    }

    port.onMessage.addListener((msg: unknown) => {
      const m = (msg ?? null) as PortMessage | null;
      if (!m || typeof m !== "object") return;
      switch (m.type) {
        case "headers":
          gotHeaders = true;
          if (typeof m.remaining === "number") handlers.onRemaining?.(m.remaining);
          if (typeof m.promptHash === "string" && m.promptHash) {
            handlers.onPromptHash?.(m.promptHash);
          }
          break;
        case "chunk":
          gotChunk = true;
          if (typeof m.text === "string") handlers.onChunk(m.text);
          break;
        case "done":
          gotDone = true;
          finish();
          break;
        case "http-error": {
          if (typeof m.remaining === "number") handlers.onRemaining?.(m.remaining);
          const err = new Error(m.message || `Request failed (${m.status ?? 0})`) as Error & {
            status?: number;
            body?: string;
          };
          err.status = m.status;
          err.body = m.body;
          finish(err);
          break;
        }
        case "error":
          finish(new Error(m.message || "stream-failed"));
          break;
      }
    });

    // A disconnect without headers/chunk/done/http-error means the worker
    // went away mid-handshake (cold SW race). Surface as a retryable network
    // error instead of silently resolving to an empty result. Even a headers-only
    // disconnect (no chunk) is a failure. No content was delivered.
    port.onDisconnect.addListener(() => {
      if (settled) return;
      if (gotDone) {
        finish();
        return;
      }
      if (!gotChunk) {
        const lastErr = browser.runtime.lastError?.message ?? "";
        const msg = isTransientRelayMessage(lastErr) ? "relay-failed" : "stream-failed";
        finish(new Error(msg));
        return;
      }
      // Mid-stream disconnect after some data. Resolve and let caller decide
      // if the buffered result is usable; empty will surface as "Empty model response".
      finish();
    });

    try {
      void port.postMessage({ type: "start", ...req });
    } catch (err) {
      finish(err instanceof Error ? err : new Error("relay-failed"));
    }
  });
}
