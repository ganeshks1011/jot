import { getBackendConfig } from "../storage";
import type { ProviderLabel } from "./types";

const KNOWN_PROVIDERS: ProviderLabel[] = ["jot-api", "opencode", "openai", "anthropic", "gemini", "grok"];

export interface ProviderMeta {
  provider: ProviderLabel;
  /** Truncated config value, never message content. Empty when unavailable. */
  model: string;
}

/**
 * Resolve the active provider + model for analytics attribution. Single
 * choke point so every rewrite event carries identical provider info.
 * Never throws; degrades to unknown/empty so analytics can't break rewrites.
 */
export async function resolveProviderMeta(): Promise<ProviderMeta> {
  try {
    const cfg = await getBackendConfig();
    const provider: ProviderLabel = (KNOWN_PROVIDERS as string[]).includes(cfg.provider)
      ? (cfg.provider as ProviderLabel)
      : "custom";
    // Model is user-controlled free text; report it only for built-in
    // providers (custom model names could contain pasted secrets).
    const model =
      provider !== "custom" && typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim().slice(0, 128) : "";
    return { provider, model };
  } catch {
    return { provider: "unknown", model: "" };
  }
}
