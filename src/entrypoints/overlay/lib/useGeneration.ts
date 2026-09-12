import { useCallback, useRef, useState } from "react";
import { type EditorType, resolveProviderMeta, siteLabelFor, track } from "@/lib/analytics";
import { ProviderError, rewriteText } from "@/lib/api";
import type { ContentStatus } from "../components/ContentBox";
import { buildCacheKey, isCacheHit } from "./generation";

export function useGeneration(
  siteRef: React.MutableRefObject<string | undefined>,
  editorRef?: React.MutableRefObject<EditorType>,
) {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<ContentStatus>("idle");
  const [error, setError] = useState<ProviderError | null>(null);

  const busyRef = useRef(false);
  const pendingRef = useRef<{ text: string; followUp?: string; html?: string | null } | null>(null);
  const lastKeyRef = useRef("");
  const lastOutputRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);

  const runGenerate = useCallback(
    async (text: string, followUp?: string, html?: string | null): Promise<string | null> => {
      if (busyRef.current || !text.trim()) return null;
      // Single-result cache: same source + tweak + site + formatting reuses
      // the last output instead of refetching.
      const key = buildCacheKey(text, followUp, siteRef.current, html);
      if (isCacheHit(key, lastKeyRef.current, lastOutputRef.current)) {
        setOutput(lastOutputRef.current);
        setStatus("output");
        setError(null);
        return lastOutputRef.current;
      }
      if (isCacheHit(key, lastKeyRef.current, lastOutputRef.current)) {
        setOutput(lastOutputRef.current);
        setStatus("output");
        setError(null);
        return lastOutputRef.current;
      }
      busyRef.current = true;
      setStatus("generating");
      setError(null);
      setOutput("");
      let streamed = "";
      const controller = new AbortController();
      abortRef.current = controller;
      let result = "";
      const providerMeta = await resolveProviderMeta();
      const meta = {
        site: siteLabelFor(siteRef.current),
        editor_type: editorRef?.current ?? ("unknown" as const),
        ...providerMeta,
      };
      const refined = !!followUp?.trim();
      const t0 = performance.now();
      void track("rewrite_started", meta);
      if (refined) void track("refinement_started", meta);
      try {
        result = await rewriteText(
          text,
          siteRef.current,
          followUp,
          {
            signal: controller.signal,
            onChunk: (delta) => {
              streamed += delta;
              setOutput(streamed);
            },
          },
          html ? { html } : undefined,
        );
        setOutput(result);
        lastKeyRef.current = key;
        lastOutputRef.current = result;
        const duration_ms = Math.round(performance.now() - t0);
        void track("rewrite_completed", { ...meta, success: true, duration_ms });
        if (refined) void track("refinement_completed", { ...meta, success: true, duration_ms });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return null;
        const duration_ms = Math.round(performance.now() - t0);
        const error_type = err instanceof ProviderError ? err.kind : "unknown";
        void track("rewrite_failed", { ...meta, success: false, error_type, duration_ms });
        setError(err instanceof ProviderError ? err : new ProviderError("network", "Something went wrong."));
        setOutput("");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        busyRef.current = false;
        setStatus("output");
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          void runGenerate(pending.text, pending.followUp, pending.html);
        }
      }
      return result || null;
    },
    [siteRef],
  );

  const clearCache = useCallback(() => {
    lastKeyRef.current = "";
    lastOutputRef.current = "";
  }, []);

  return {
    output,
    setOutput,
    status,
    setStatus,
    error,
    setError,
    busyRef,
    pendingRef,
    abortRef,
    runGenerate,
    clearCache,
  };
}
