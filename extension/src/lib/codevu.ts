/**
 * Codevu backend: the built-in rewrite service for Jot (https://codevu.com).
 *
 * Plain JSON over HTTPS, no streaming frames, no sign-in. The extension
 * identifies itself with an anonymous per-install UUID (chrome.storage.local,
 * generated on first run). Quota is enforced server-side: 100 free rewrites
 * per calendar month per install.
 *
 * All HTTP goes through the background relay (net.ts), per the extension
 * convention: overlay/options pages are CORS-bound without host
 * permissions, the service worker is not.
 *
 * Endpoints:
 *   POST /api/jot/v1/rewrite   { installId, text, style? } -> { ok, rewrite, quota }
 *   GET  /api/jot/v1/quota?installId=                      -> { ok, quota }
 *   POST /api/jot/v1/analytics { installId?, event }       -> { ok: true }
 */
import { CODEVU_ORIGIN } from "./config";
import { relayFetch } from "./net";
import { getInstallId } from "./storage";
import { ProviderError } from "./providers";

export interface CodevuQuota {
  used: number;
  limit: number;
  resetsAt: string;
}

function codevuUrl(path: string): string {
  return `${CODEVU_ORIGIN.replace(/\/+$/, "")}${path}`;
}

function errorCodeOf(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `http_${status}`;
  } catch {
    return `http_${status}`;
  }
}

interface CodevuRewriteBody {
  ok?: boolean;
  rewrite?: unknown;
}

interface CodevuQuotaBody {
  ok?: boolean;
  quota?: unknown;
}

/**
 * Rewrite text through the codevu backend. Text must already be redacted
 * by the caller; this function sends it as-is.
 */
export async function rewriteViaCodevu(
  text: string,
  style: string,
  onChunk?: (delta: string) => void,
): Promise<string> {
  const installId = await getInstallId();
  let res;
  try {
    res = await relayFetch({
      url: codevuUrl("/api/jot/v1/rewrite"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installId, text, style: style || undefined }),
    });
  } catch {
    throw new ProviderError("network", "Could not reach the Jot backend");
  }
  if (res.status === 429) {
    throw new ProviderError(
      "quota",
      "You have used all 100 free rewrites for this month. They reset next month.",
    );
  }
  if (!res.ok) {
    throw new ProviderError("network", errorCodeOf(res.status, res.text), {
      status: res.status,
    });
  }
  const body = JSON.parse(res.text) as CodevuRewriteBody;
  if (!body.ok || typeof body.rewrite !== "string" || !body.rewrite.trim()) {
    throw new ProviderError("empty", "Empty model response");
  }
  onChunk?.(body.rewrite);
  return body.rewrite;
}

/** Current quota for this install; null when unreachable (offline-safe). */
export async function getCodevuQuota(): Promise<CodevuQuota | null> {
  try {
    const installId = await getInstallId();
    const res = await relayFetch({
      url: codevuUrl(
        `/api/jot/v1/quota?installId=${encodeURIComponent(installId)}`,
      ),
      method: "GET",
    });
    if (!res.ok) return null;
    const body = JSON.parse(res.text) as CodevuQuotaBody;
    const quota = body.quota as CodevuQuota | undefined;
    return body.ok && quota && typeof quota.used === "number" ? quota : null;
  } catch {
    return null;
  }
}

/** Public site URL for onboarding links and the upgrade fallback. */
export function codevuSiteUrl(path = "/jot"): string {
  return codevuUrl(path);
}
