/**
 * Host adapter: the only seam between the shared JotAssistant card and its
 * host. The Chrome extension implements transport over the background relay
 * plus host-DOM messaging; the website implements it over the landing
 * rewrite API. Neither side leaks into the shared component.
 */

import type { LexicalTextNode } from "@wurkflo/shared";

export type RewriteErrorKind = "no-key" | "auth" | "rate-limit" | "network" | "empty" | "quota";

export interface RewriteQuota {
  used: number;
  limit: number;
  remaining: number;
  period: string;
}

export interface RewriteUpgrade {
  available: boolean;
  planId?: string | null;
  name?: string | null;
  message?: string | null;
  redirectUri?: string | null;
}

/** Structural error every adapter transport rejects with. */
export interface RewriteErrorShape {
  kind: RewriteErrorKind;
  message: string;
  quota?: RewriteQuota | null;
  upgrade?: RewriteUpgrade | null;
}

const ERROR_KINDS: ReadonlySet<string> = new Set(["no-key", "auth", "rate-limit", "network", "empty", "quota"]);

export function isRewriteError(err: unknown): err is RewriteErrorShape {
  if (!err || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" && ERROR_KINDS.has(kind);
}

export function toRewriteError(err: unknown): RewriteErrorShape {
  if (isRewriteError(err)) return err;
  return { kind: "network", message: "Something went wrong." };
}

/** Canonical assistant events. Adapters map these onto their own analytics. */
export type JotAssistantEvent =
  | "rewrite_started"
  | "refinement_started"
  | "rewrite_completed"
  | "rewrite_failed"
  | "rewrite_applied"
  | "rewrite_copied"
  | "refinement_completed";

export interface JotTrackParams {
  site?: string;
  editorType?: string;
  success?: boolean;
  errorType?: string;
  durationMs?: number;
  confirmed?: boolean;
}

export interface RewriteRequest {
  text: string;
  html?: string | null;
  nodes?: LexicalTextNode[] | null;
  followUp?: string;
  /** Instruction for hosts that need one (the website); ignored by hosts
   *  that resolve prompts internally (the extension personalization flow). */
  systemPrompt?: string;
  /** Analytics context; adapters enrich or ignore it. */
  site?: string;
  editorType?: string;
}

export interface RewriteResult {
  output: string;
  htmlPreview?: string | null;
}

export interface InsertFailureMetrics {
  strategy?: "exec" | "beforeinput" | "entity" | null;
  tag?: string | null;
  preLen?: number | null;
  postLen?: number | null;
  expectedLen?: number | null;
  attempts?: number | null;
}

export type InsertVerdict =
  | { ok: true }
  | { ok: false; text: string; html: string | null; metrics?: InsertFailureMetrics };

export type InsertOutcome =
  | { kind: "done" }
  | {
      kind: "await-verdict";
      subscribe(cb: (verdict: InsertVerdict) => void): () => void;
      /** Backstop before auto-closing a verdict-less host (default 15000). */
      settleMs?: number;
    };

export interface JotHostAdapter {
  /** Stream one rewrite. Resolves with the full output; rejects with a RewriteErrorShape. */
  rewrite(req: RewriteRequest, handlers: { signal: AbortSignal; onToken(token: string): void }): Promise<RewriteResult>;
  /** Keyed Lexical rewrite. Absent = host can't do keyed; the component falls back to the string flow. */
  rewriteKeyed?(
    nodes: LexicalTextNode[],
    opts: { source: string; followUp?: string; signal: AbortSignal },
  ): Promise<{ map: Record<string, string>; htmlPreview: string | null }>;
  /** Apply the rewrite at the host target. `map` carries the keyed
   *  Lexical commit for hosts that write through a live editor. */
  insert(payload: { text: string; html: string | null; map?: Record<string, string> | null }): InsertOutcome;
  track(event: JotAssistantEvent, params?: JotTrackParams): void;
  openSettings(): void;
  openUpgrade(info: RewriteUpgrade): void;
  close(): void;
  sanitizeHtml(html: string): string;
  toPlainText(html: string, fallback: string): string;
  logoSrc: string;
}
