import { getNextSlug, slugify } from "./providers";
import type { CustomProviderMeta } from "./types";

export interface CustomProviderForm {
  label: string;
  baseUrl: string;
  model: string;
  apiKeyUrl?: string;
  headersText?: string;
}

export function validateCustomProvider(form: CustomProviderForm): { error?: string; meta?: CustomProviderMeta } {
  const label = form.label.trim();
  const url = form.baseUrl.trim();
  const mdl = form.model.trim();
  if (!label || !url || !mdl) return { error: "Custom provider requires label, base URL, and model" };
  try {
    new URL(url);
  } catch {
    return { error: "Custom base URL must be a valid URL" };
  }
  const keyPage = form.apiKeyUrl?.trim() || undefined;
  if (keyPage) {
    // The key-page URL is opened via tabs.create. Restrict it to https.
    // (loopback http allowed for local dashboards) so a synced or mistyped
    // entry can't trigger an unexpected scheme.
    let parsedKeyPage: URL;
    try {
      parsedKeyPage = new URL(keyPage);
    } catch {
      return { error: "API key page must be a valid URL" };
    }
    const host = parsedKeyPage.hostname;
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (parsedKeyPage.protocol !== "https:" && !(parsedKeyPage.protocol === "http:" && loopback)) {
      return { error: "API key page must be an https URL" };
    }
  }
  const baseSlug = slugify(label);
  const id = getNextSlug(baseSlug);
  let extraHeaders: Record<string, string> | undefined;
  if (form.headersText?.trim()) {
    extraHeaders = {};
    for (const line of form.headersText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) return { error: `Header line must be "Key: Value", got "${trimmed}"` };
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (!k || !v) return { error: `Header line must be "Key: Value", got "${trimmed}"` };
      extraHeaders[k] = v;
    }
  }
  return {
    meta: {
      id,
      label,
      baseUrl: url,
      defaultModel: mdl,
      apiKeyUrl: keyPage,
      ...(extraHeaders ? { extraHeaders } : {}),
    },
  };
}
