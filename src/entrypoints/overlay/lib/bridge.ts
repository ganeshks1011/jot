/**
 * postMessage contract between the overlay iframe and the content script.
 * See docs/PLAN.md §6.
 *
 * - The content script posts `{ type: "init", ... }` into the iframe on open.
 * - The iframe posts `resize` / `insert` / `close` events to the parent.
 *
 * The content script validates `event.source`/`event.origin` on its side.
 * The iframe validates `event.source === window.parent` (messages from the
 * host page arrive with the page's origin, so source matching is the safe
 * check here).
 */

import type { LexicalTextNode } from "@wurkflo/shared";

export type OverlayPlacement = "above" | "below" | "float" | "fullscreen";

export interface OverlayInitMessage {
  type: "init";
  text?: string;
  style?: string | null;
  fieldType?: string | null;
  site?: string | null;
  /** Where the overlay sits relative to the composer (connector edge). */
  placement?: OverlayPlacement | null;
  /** Sampled composer colors to mirror (null = theme fallback). */
  composerBg?: string | null;
  composerFg?: string | null;
  /** True when the page behind the panel is dark (neutral shadow color). */
  pageDark?: boolean | null;
  /** Card-relative x of the connector diamond (null = hidden). */
  connectorX?: number | null;
  /** True when the host reports a write verdict (no blind auto-close). */
  verifiedWrite?: boolean | null;
  /** Panel height budget in px (null = default cap). */
  maxPanelHeight?: number | null;
  /** Sanitized HTML fragment when the capture carried formatting. */
  html?: string | null;
  /** True when the capture had bold/italics/lists to preserve. */
  hasFormatting?: boolean | null;
  /** True when the capture spanned multiple lines. */
  multiline?: boolean | null;
  /** Lexical index-path text nodes for the keyed rewrite flow (if any). */
  lexicalNodes?: LexicalTextNode[] | null;
}

/** Host → overlay: refreshed placement + panel budget after viewport resize. */
export interface HostMetricsMessage {
  type: "metrics";
  placement: OverlayPlacement;
  maxPanelHeight: number | null;
  connectorX: number | null;
}

export type OverlayOutMessage =
  | { type: "ready" }
  | { type: "resize"; height: number; compact?: boolean | null }
  | { type: "insert"; text: string; html?: string | null }
  | { type: "insertLexical"; map: Record<string, string>; text: string; html?: string | null }
  | { type: "close" };

/** Text-free write metrics (lengths/tags only, never message content). */
export interface InsertMetrics {
  strategy: "exec" | "beforeinput" | "entity" | null;
  tag: string | null;
  preLen: number;
  postLen: number;
  expectedLen: number;
  attempts: number;
}

/** Host → overlay: Slack write verdict, success or failure. */
export interface HostInsertResultMessage extends InsertMetrics {
  type: "insert-result";
  ok: boolean;
}

/** Host → overlay: a verified write-back failed; the panel stays open. */
export interface HostInsertFailedMessage extends Partial<InsertMetrics> {
  type: "insert-failed";
  text: string;
  /** Sanitized HTML for manual paste with formatting intact (if any). */
  html?: string | null;
}

/** True when rendered inside the content-script-created iframe. */
export const isEmbedded = (): boolean => window.parent !== window;

export function postToParent(msg: OverlayOutMessage): void {
  if (!isEmbedded()) return;
  window.parent.postMessage(msg, "*");
}

/** Signals the content script that the init listener is attached. */
export function postReady(): void {
  postToParent({ type: "ready" });
}

export function postResize(compact?: boolean | null): void {
  postToParent({
    type: "resize",
    height: Math.ceil(document.documentElement.scrollHeight),
    compact: compact ?? null,
  });
}

export function onInit(cb: (msg: OverlayInitMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (!isEmbedded()) return;
    if (e.source !== window.parent) return;
    const msg = e.data as OverlayInitMessage | null;
    if (msg && typeof msg === "object" && msg.type === "init") cb(msg);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Host-pushed metrics (placement + panel budget) after viewport resize. */
export function onMetrics(cb: (msg: HostMetricsMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (!isEmbedded()) return;
    if (e.source !== window.parent) return;
    const msg = e.data as HostMetricsMessage | null;
    if (msg && typeof msg === "object" && msg.type === "metrics") {
      cb(msg);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Host-reported write failures (e.g. Slack composer rejected the edit). */
export function onInsertFailed(cb: (msg: HostInsertFailedMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (!isEmbedded()) return;
    if (e.source !== window.parent) return;
    const msg = e.data as HostInsertFailedMessage | null;
    if (msg && typeof msg === "object" && msg.type === "insert-failed" && typeof msg.text === "string") {
      cb(msg);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Host-reported Slack write verdicts (diagnostic trail for silent closes). */
export function onInsertResult(cb: (msg: HostInsertResultMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (!isEmbedded()) return;
    if (e.source !== window.parent) return;
    const msg = e.data as HostInsertResultMessage | null;
    if (msg && typeof msg === "object" && msg.type === "insert-result" && typeof msg.ok === "boolean") {
      cb(msg);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
