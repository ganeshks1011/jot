import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { JotHostAdapter } from "./adapter";
import { toRewriteError, type RewriteErrorShape } from "./adapter";
import type { ContentStatus } from "../components/ContentBox";
import { buildCacheKey, isCacheHit } from "./generation";

export function useJotGeneration(
  adapter: JotHostAdapter,
  siteRef: MutableRefObject<string | undefined>,
  editorRef?: MutableRefObject<string>,
) {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<ContentStatus>("idle");
  const [error, setError] = useState<RewriteErrorShape | null>(null);

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
      busyRef.current = true;
      setStatus("generating");
      setError(null);
      setOutput("");
      let streamed = "";
      const controller = new AbortController();
      abortRef.current = controller;
      let result = "";
      const site = siteRef.current;
      const editorType = editorRef?.current;
      const refined = !!followUp?.trim();
      const t0 = performance.now();
      adapter.track("rewrite_started", { site, editorType });
      if (refined) adapter.track("refinement_started", { site, editorType });
      try {
        const res = await adapter.rewrite(
          { text, html, followUp },
          {
            signal: controller.signal,
            onToken: (delta) => {
              streamed += delta;
              setOutput(streamed);
            },
          },
        );
        result = res.output;
        setOutput(result);
        lastKeyRef.current = key;
        lastOutputRef.current = result;
        const durationMs = Math.round(performance.now() - t0);
        adapter.track("rewrite_completed", { site, editorType, success: true, durationMs });
        if (refined) adapter.track("refinement_completed", { site, editorType, success: true, durationMs });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return null;
        const durationMs = Math.round(performance.now() - t0);
        const shaped = toRewriteError(err);
        adapter.track("rewrite_failed", { site, editorType, success: false, errorType: shaped.kind, durationMs });
        setError(shaped);
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
    [adapter, siteRef, editorRef],
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
