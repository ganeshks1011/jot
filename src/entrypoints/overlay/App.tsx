/**
 * Extension overlay entry: thin host glue around the shared JotAssistant
 * card. Owns the host-controller contract (init source + appearance,
 * metrics, resize reporting, ready handshake) and delegates everything
 * visible and interactive — generation, insert, copy, keyboard, errors —
 * to @wurkflo/jot-ui with the Chrome host adapter.
 */

import { type JotAppearance, JotAssistant, type JotSizeReporter, type JotSource } from "@wurkflo/jot-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorType } from "@/lib/analytics";
import { MIN_CONTENT_HEIGHT } from "@/lib/overlayGeometry";
import { canonicalEditorType, createChromeAdapter } from "./adapter";
import { isEmbedded, onInit, onMetrics, postReady, postResize } from "./lib/bridge";
import { READY_MAX_RETRIES, READY_RETRY_INTERVAL_MS, startReadyRetry } from "./lib/readyRetry";

const SAMPLE_TEXT = "This is the sample selection used to preview the overlay outside of an extension host.";

export default function App() {
  const [source, setSource] = useState<JotSource>({ text: "" });
  const [autoGenerateKey, setAutoGenerateKey] = useState("init");
  const [appearance, setAppearance] = useState<JotAppearance>({});
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);
  // Dev preview outside a host: render the card without generating.
  const [preview] = useState(() => !isEmbedded());
  // Host handshake: the card shows a loading glimmer until the first `init`
  // lands. If the host is broken and `init` never arrives, fall back to the
  // idle hint after the ready-retry budget is spent.
  const [initReceived, setInitReceived] = useState(false);
  const [initTimedOut, setInitTimedOut] = useState(false);

  const siteRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorType>("unknown");
  const verifiedWriteRef = useRef(false);
  const maxPanelHeightRef = useRef<number | null>(null);
  useEffect(() => {
    maxPanelHeightRef.current = maxPanelHeight;
  }, [maxPanelHeight]);

  const adapter = useMemo(() => createChromeAdapter({ siteRef, editorRef, verifiedWriteRef }), []);

  // First paint already showed the static boot skeleton (index.html).
  // Remove it pre-paint so it never overlaps the React card for a frame.
  useLayoutEffect(() => {
    document.getElementById("jot-boot")?.remove();
  }, []);

  // Initialize from the content script's captured selection. A per-init
  // counter forces re-evaluation even for identical text+site (mode
  // hierarchy may have changed); the card queues behind in-flight runs.
  useEffect(() => {
    let initCount = 0;
    let settled = false;
    const unsub = onInit((msg) => {
      settled = true;
      setInitReceived(true);
      const text = msg.text ?? "";
      const site = msg.site ?? undefined;
      const html = msg.html ?? null;
      const formatted = msg.hasFormatting === true && !!html;
      siteRef.current = site;
      editorRef.current = canonicalEditorType(msg.fieldType);
      verifiedWriteRef.current = msg.verifiedWrite ?? false;
      setAppearance({
        composerBg: msg.composerBg ?? null,
        composerFg: msg.composerFg ?? null,
        pageDark: msg.pageDark ?? null,
        fullscreen: (msg.placement ?? "float") === "fullscreen",
      });
      setMaxPanelHeight(msg.maxPanelHeight ?? null);
      setSource({
        text,
        html: formatted ? html : null,
        nodes: msg.lexicalNodes && msg.lexicalNodes.length > 0 ? msg.lexicalNodes : null,
      });
      initCount += 1;
      setAutoGenerateKey(`${text}||${site ?? ""}||${formatted ? "html" : "plain"}||${initCount}`);
    });

    if (!isEmbedded()) {
      setSource({ text: SAMPLE_TEXT });
    }

    postReady();
    // Cold first-invoke: the host may have posted `init` before this
    // listener attached. Re-post `ready` until the first `init` lands so
    // the host's forced resend reaches us; stops on init or unmount.
    const stopRetry = startReadyRetry(postReady, () => settled);
    // Broken host: stop shimmering once the retry budget is spent so the
    // card falls back to the idle hint instead of loading forever.
    const timeout = setTimeout(
      () => {
        if (!settled) setInitTimedOut(true);
      },
      READY_RETRY_INTERVAL_MS * (READY_MAX_RETRIES + 1),
    );
    return () => {
      clearTimeout(timeout);
      stopRetry();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Host-pushed metrics (placement + panel budget) after viewport resize.
  useEffect(() => {
    return onMetrics((msg) => {
      setAppearance((prev) => ({ ...prev, fullscreen: msg.placement === "fullscreen" }));
      setMaxPanelHeight(msg.maxPanelHeight ?? null);
    });
  }, []);

  // Grow the result box with its content, capped by the host-provided panel
  // budget minus measured chrome (header/footer/hints/gaps). The card
  // notifies on every content change; the host decides placement from
  // content that wants to exist, not from the height the cap allows.
  const sizeReporter = useMemo<JotSizeReporter>(
    () => ({
      notify: (compact: boolean) => {
        const content = document.getElementById("jot-content");
        const card = content?.closest(".jot-card-glow");
        if (!card || !(content instanceof HTMLElement)) return;
        const cardEl = card as HTMLElement;
        if (content instanceof HTMLTextAreaElement) {
          content.style.height = "auto";
          content.style.height = `${content.scrollHeight}px`;
        }
        const maxH = maxPanelHeightRef.current;
        if (maxH == null) {
          cardEl.style.removeProperty("--jot-content-max");
          return;
        }
        const chrome = cardEl.scrollHeight - content.scrollHeight;
        const cap = Math.max(MIN_CONTENT_HEIGHT, maxH - chrome);
        cardEl.style.setProperty("--jot-content-max", `${Math.round(cap)}px`);
        postResize(compact, content.scrollHeight);
      },
    }),
    [],
  );

  useEffect(() => {
    const initial = setTimeout(() => sizeReporter.notify(true), 100);
    const late = setTimeout(() => sizeReporter.notify(true), 450);
    return () => {
      clearTimeout(initial);
      clearTimeout(late);
    };
  }, [sizeReporter]);

  return (
    <JotAssistant
      source={source}
      autoGenerateKey={autoGenerateKey}
      autoGenerate={!preview}
      adapter={adapter}
      appearance={appearance}
      sizeReporter={sizeReporter}
      awaitingInit={!preview && !initReceived && !initTimedOut}
      emptyPrompt={initReceived && !source.text.trim()}
    />
  );
}
