import { getAdapter } from "./providers";
import type { ProviderId } from "./types";

export function validateApiKey(provider: ProviderId, key: string, baseUrl?: string): string | null {
  const trimmed = key.trim();
  if (provider === "jot-api") return null;
  const lowerBase = (baseUrl ?? "").toLowerCase();
  if (lowerBase.includes("localhost") || lowerBase.includes("127.0.0.1") || lowerBase.includes("::1")) return null;
  if (!trimmed) {
    const label = getAdapter(provider)?.label ?? provider;
    return `Enter your ${label} API key`;
  }
  // Optional strict check for Gemini: must look like AIza...
  if (provider === "gemini" && !/^AIza[0-9A-Za-z_-]{30,}$/.test(trimmed)) {
    // still allow, but warn if obviously wrong? For now just check non-empty
    // keep lenient: only warn if too short
    if (trimmed.length < 20) return `Enter your Gemini API key (starts with AIza)`;
  }
  return null;
}
