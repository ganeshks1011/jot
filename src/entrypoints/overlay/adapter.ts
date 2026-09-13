/**
 * Chrome host adapter for the shared JotAssistant card.
 *
 * Transport runs over the background relay (api.ts — the overlay iframe
 * never fetches providers directly), inserts travel through the injected
 * host controller via the postMessage bridge, and analytics are enriched
 * with site/editor/provider context. Created per overlay mount with refs
 * the App updates on every init message.
 */

import type {
  InsertOutcome,
  JotAssistantEvent,
  JotHostAdapter,
  JotTrackParams,
  RewriteRequest,
  RewriteResult,
  RewriteUpgrade,
} from "@wurkflo/jot-ui";
import type { LexicalTextNode } from "@wurkflo/shared";
import type { MutableRefObject } from "react";
import { browser } from "wxt/browser";
import { editorTypeFor, resolveProviderMeta, siteLabelFor, track } from "@/lib/analytics";
import type { AnalyticsErrorType, AnalyticsEventName, AnalyticsParams, EditorType } from "@/lib/analytics";
import { rewriteLexicalNodes, rewriteText } from "@/lib/api";
import { WURKFLO_ORIGIN } from "@/lib/config";
import { htmlToPlainText, sanitizeRichHtml } from "@/lib/richText";
import { onInsertFailed, onInsertResult, postToParent } from "./lib/bridge";

export interface ChromeAdapterRefs {
  siteRef: MutableRefObject<string | undefined>;
  editorRef: MutableRefObject<EditorType>;
  verifiedWriteRef: MutableRefObject<boolean>;
}

const TRACKED_EVENTS: ReadonlySet<string> = new Set([
  "rewrite_started",
  "refinement_started",
  "rewrite_completed",
  "rewrite_failed",
  "rewrite_applied",
  "rewrite_copied",
  "refinement_completed",
]);

export function createChromeAdapter({ siteRef, editorRef, verifiedWriteRef }: ChromeAdapterRefs): JotHostAdapter {
  const enrichedTrack = (event: JotAssistantEvent, params?: JotTrackParams): void => {
    if (!TRACKED_EVENTS.has(event)) return;
    void (async () => {
      let providerMeta: Partial<AnalyticsParams> = {};
      try {
        providerMeta = (await resolveProviderMeta()) as unknown as Partial<AnalyticsParams>;
      } catch {
        // Anonymous at worst; the event still lands.
      }
      const enriched: AnalyticsParams = {
        site: siteLabelFor(params?.site ?? siteRef.current),
        editor_type: (params?.editorType as EditorType | undefined) ?? editorRef.current,
        ...providerMeta,
      };
      if (params?.success !== undefined) enriched.success = params.success;
      if (params?.errorType) enriched.error_type = params.errorType as AnalyticsErrorType;
      if (params?.durationMs !== undefined) enriched.duration_ms = params.durationMs;
      if (params?.confirmed !== undefined) enriched.confirmed = params.confirmed;
      void track(event as AnalyticsEventName, enriched);
    })();
  };

  return {
    logoSrc: browser.runtime.getURL("/icon/icon128.png"),

    async rewrite(
      req: RewriteRequest,
      handlers: { signal: AbortSignal; onToken(token: string): void },
    ): Promise<RewriteResult> {
      // The system instruction is resolved inside api.ts from the
      // personalization hierarchy; req.systemPrompt is intentionally unused.
      const output = await rewriteText(req.text, req.site ?? siteRef.current, req.followUp, {
        signal: handlers.signal,
        onChunk: handlers.onToken,
      }, req.html ? { html: req.html } : undefined);
      return { output };
    },

    async rewriteKeyed(
      nodes: LexicalTextNode[],
      opts: { source: string; followUp?: string; signal: AbortSignal },
    ): Promise<{ map: Record<string, string>; htmlPreview: string | null }> {
      const map = await rewriteLexicalNodes(nodes, {
        source: opts.source,
        site: siteRef.current,
        followUp: opts.followUp,
        handlers: { signal: opts.signal },
      });
      // Preview HTML is rebuilt by the shared card via sanitizeHtml.
      return { map, htmlPreview: null };
    },

    insert({ text, html, map }): InsertOutcome {
      if (map) {
        postToParent({ type: "insertLexical", map, text, html });
      } else {
        postToParent({ type: "insert", text, html });
      }
      return {
        kind: "await-verdict",
        // Verified targets hold the panel open for the host verdict;
        // blind targets fall back to the historic 700ms auto-close.
        settleMs: verifiedWriteRef.current ? 15000 : 700,
        subscribe: (cb) => {
          const unsubs = [
            onInsertResult((msg) => {
              if (msg.ok) cb({ ok: true });
            }),
            onInsertFailed((msg) =>
              cb({
                ok: false,
                text: msg.text,
                html: typeof msg.html === "string" ? msg.html : null,
                metrics: {
                  strategy: msg.strategy ?? null,
                  tag: msg.tag ?? null,
                  preLen: msg.preLen ?? null,
                  postLen: msg.postLen ?? null,
                  expectedLen: msg.expectedLen ?? null,
                  attempts: msg.attempts ?? null,
                },
              }),
            ),
          ];
          return () => unsubs.forEach((unsub) => unsub());
        },
      };
    },

    track: enrichedTrack,

    openSettings(): void {
      void browser.runtime.openOptionsPage();
    },

    openUpgrade(info: RewriteUpgrade): void {
      const uri = info.redirectUri?.trim();
      // Validate relative redirectUri. Never trust arbitrary URLs.
      const safeUri = uri && uri.startsWith("/") ? uri : "/jot/upgrade";
      void browser.tabs.create({ url: `${WURKFLO_ORIGIN.replace(/\/+$/, "")}${safeUri}` });
    },

    close(): void {
      postToParent({ type: "close" });
    },

    sanitizeHtml(html: string): string {
      return sanitizeRichHtml(html);
    },

    toPlainText(html: string): string {
      return htmlToPlainText(html);
    },
  };
}

/** Keep editor labels canonical at the boundary (unknown stays unknown). */
export function canonicalEditorType(fieldType?: string | null): EditorType {
  return editorTypeFor(fieldType);
}
