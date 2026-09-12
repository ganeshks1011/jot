import type { BackendConfig } from "../types";

export type ProviderErrorKind = "no-key" | "auth" | "rate-limit" | "network" | "empty" | "quota";

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  period: string;
}

export interface UpgradeInfo {
  available: boolean;
  planId: string | null;
  name: string | null;
  message: string | null;
  redirectUri: string | null;
}

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  quota?: QuotaInfo | null;
  upgrade?: UpgradeInfo | null;
  status?: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts?: { quota?: QuotaInfo | null; upgrade?: UpgradeInfo | null; status?: number },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.quota = opts?.quota ?? null;
    this.upgrade = opts?.upgrade ?? null;
    this.status = opts?.status;
  }
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  /** Optional URL where the user can obtain an API key for this provider. */
  readonly apiKeyUrl?: string;
  /** True when the backend enforces tiers/quota server-side (client counters skipped). */
  readonly tiersEnforcedServerSide: boolean;
  rewrite(config: BackendConfig, apiKey: string, system: string, user: string): Promise<string>;
  listModels(config: BackendConfig, apiKey: string): Promise<string[]>;
}
