/**
 * JotAssistant: the shared Jot overlay card. One implementation rendered
 * by the Chrome extension (anchored iframe) and the website (anchored demo
 * card, modal content). Every host dependency — rewrite transport, insert
 * target, settings/upgrade destinations, analytics, close — arrives via
 * the injected JotHostAdapter. No chrome.*, no fetches, no host DOM here.
 */

import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Kbd } from "@heroui/react/kbd";
import { Tooltip } from "@heroui/react/tooltip";
import type { LexicalTextNode } from "@wurkflo/shared";
import { Check, Settings as SettingsIcon, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { ContentBox } from "../components/ContentBox";
import { FeedbackInput } from "../components/FeedbackInput";
import type { InsertFailureMetrics, JotHostAdapter, RewriteUpgrade } from "./adapter";
import { type ContentNodeLike, copyDomHtml, copyHtml } from "./clipboard";
import { describeInsertMetrics, errorMessage } from "./errorText";
import { type FocusZone, selectHelperText, zoneForTarget } from "./helperText";
import { buildKeyedHtml } from "./keyedHtml";
import { useJotGeneration } from "./useJotGeneration";

export interface JotSource {
  text: string;
  html?: string | null;
  nodes?: LexicalTextNode[] | null;
}

export interface JotAppearance {
  composerBg?: string | null;
  composerFg?: string | null;
  pageDark?: boolean | null;
  fullscreen?: boolean;
  /** Max height of the result box (CSS length). Unset = 38vh default. */
  contentMax?: string;
}

export interface JotSizeReporter {
  /** Content size or status changed; host re-measures and budgets. */
  notify(compact: boolean): void;
}

interface JotAssistantProps {
  source: JotSource;
  /** Re-run generation when this changes (extension: init key; web: open key). */
  autoGenerateKey: string;
  /** Skip generation entirely (extension dev preview outside a host). */
  autoGenerate?: boolean;
  adapter: JotHostAdapter;
  appearance?: JotAppearance;
  /** Analytics context; adapters enrich or ignore it. */
  site?: string;
  editorType?: string;
  /** Fired when a generation begins (hosts hook funnel events here). */
  onRewriteStart?: () => void;
  /** Host iframe sizing; absent on the website (no iframe to size). */
  sizeReporter?: JotSizeReporter;
  /** Show the header settings action. False on the website (the gear is
   *  extension chrome); the Style screen covers its job there. */
  showSettingsAction?: boolean;
}

/** Upgrade action with the upgrade payload captured (avoids re-narrowing). */
function UpgradeButton({ upgrade, onUpgrade }: { upgrade: RewriteUpgrade; onUpgrade: (info: RewriteUpgrade) => void }) {
  return (
    <Button size="sm" variant="primary" onPress={() => onUpgrade(upgrade)}>
      {upgrade.name ? `Upgrade to ${upgrade.name}` : "Upgrade"}
    </Button>
  );
}

/** Select the live preview node so a legacy execCommand copy carries its
 *  HTML (same as manual Cmd+C). Throws when selection is unavailable so
 *  the caller degrades to the plain-text textarea path. */
function prepareDomCopy(el: ContentNodeLike): void {
  const sel = window.getSelection();
  if (!sel) throw new Error("selection unavailable");
  sel.removeAllRanges();
  sel.selectAllChildren(el as unknown as Node);
}

export function JotAssistant({
  source,
  autoGenerateKey,
  autoGenerate = true,
  adapter,
  appearance,
  site,
  editorType,
  onRewriteStart,
  sizeReporter,
  showSettingsAction = true,
}: JotAssistantProps) {
  const [inputText, setInputText] = useState("");
  const [inserted, setInserted] = useState(false);
  // Rewrite the host rejected. Panel stays open so the user can copy it
  // instead of losing the result.
  const [failedText, setFailedText] = useState<string | null>(null);
  const [failedHtml, setFailedHtml] = useState<string | null>(null);
  const [failedMetrics, setFailedMetrics] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const siteRef = useRef<string | undefined>(site);
  const editorRef = useRef<string>(editorType ?? "unknown");
  useEffect(() => {
    siteRef.current = site;
    editorRef.current = editorType ?? "unknown";
  }, [site, editorType]);

  const sourceRef = useRef(source);
  sourceRef.current = source;
  const onRewriteStartRef = useRef(onRewriteStart);
  onRewriteStartRef.current = onRewriteStart;

  const {
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
  } = useJotGeneration(adapter, siteRef, editorRef);

  // Lexical keyed flow: index-path nodes from the host for the structure-
  // preserving rewrite. Refs only: every map arrival also sets output,
  // which re-renders.
  const nodesRef = useRef<LexicalTextNode[] | null>(null);
  const mapRef = useRef<Record<string, string> | null>(null);
  const keyedBusyRef = useRef(false);
  // Built keyed HTML for preview, clipboard flavors, and the insert
  // payload: one source so all three surfaces always agree.
  const [keyedHtml, setKeyedHtml] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const insertedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verdictTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verdictUnsub = useRef<(() => void) | null>(null);

  // Rewrite the captured source, applying the input box text as a tweak
  // instruction on top. Formatting HTML travels alongside the plain source
  // so the model can preserve tags it otherwise could not see.
  // Lexical keyed flow first when the host supplied nodes: structure is
  // rewritten by id and committed atomically by the host instance.
  const runKeyedGenerate = useCallback(
    async (nodes: LexicalTextNode[], followUp?: string) => {
      const current = sourceRef.current;
      if (keyedBusyRef.current || nodes.length === 0) return;
      keyedBusyRef.current = true;
      busyRef.current = true;
      setStatus("generating");
      setError(null);
      setOutput("");
      mapRef.current = null;
      setKeyedHtml(null);
      const controller = new AbortController();
      abortRef.current = controller;
      let handedOff = false;
      try {
        if (!adapter.rewriteKeyed) throw new Error("keyed unsupported");
        const { map, htmlPreview } = await adapter.rewriteKeyed(nodes, {
          source: current.text,
          followUp,
          signal: controller.signal,
        });
        mapRef.current = map;
        const built = buildKeyedHtml(nodes, map, adapter.sanitizeHtml);
        setKeyedHtml(htmlPreview ?? built);
        setOutput(nodes.map((n) => map[n.id] ?? n.text).join("\n\n"));
        setStatus("output");
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // Keyed failure falls through to the string flow below when the
        // run was the initial auto-generate; tweaks surface the error.
        if (!followUp) {
          nodesRef.current = null;
          mapRef.current = null;
          setKeyedHtml(null);
          setStatus("idle");
          keyedBusyRef.current = false;
          handedOff = true;
          onRewriteStartRef.current?.();
          void runGenerate(current.text, undefined, current.html ?? null);
          return;
        }
        setError({ kind: "network", message: "Something went wrong." });
        setOutput("");
        setKeyedHtml(null);
        setStatus("output");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        // A handed-off string run owns the busy flag from here.
        if (!handedOff) busyRef.current = false;
        keyedBusyRef.current = false;
      }
    },
    [adapter, runGenerate, abortRef, busyRef],
  );

  const generate = useCallback(
    (followUp?: string) => {
      const current = sourceRef.current;
      if (!current.text.trim()) return;
      if (busyRef.current || keyedBusyRef.current) {
        pendingRef.current = { text: current.text, followUp, html: current.html ?? null };
        return;
      }
      const nodes = nodesRef.current;
      if (nodes && nodes.length > 0 && adapter.rewriteKeyed) {
        void runKeyedGenerate(nodes, followUp);
        return;
      }
      mapRef.current = null;
      setKeyedHtml(null);
      onRewriteStartRef.current?.();
      void runGenerate(current.text, followUp, current.html ?? null);
    },
    [adapter, runGenerate, runKeyedGenerate],
  );

  // Auto-generate when the key changes (new init on extension, new open on
  // web). Queues behind an in-flight run rather than dropping.
  useEffect(() => {
    if (!autoGenerate) {
      setStatus("idle");
      return;
    }
    const current = sourceRef.current;
    nodesRef.current = current.nodes && current.nodes.length > 0 ? current.nodes : null;
    mapRef.current = null;
    setKeyedHtml(null);
    clearCache();
    if (!current.text) {
      setStatus("idle");
      return;
    }
    if (busyRef.current || keyedBusyRef.current) {
      nodesRef.current = null;
      mapRef.current = null;
      pendingRef.current = { text: current.text, html: current.html ?? null };
      abortRef.current?.abort();
      return;
    }
    onRewriteStartRef.current?.();
    if (nodesRef.current && adapter.rewriteKeyed) {
      void runKeyedGenerate(nodesRef.current);
    } else {
      nodesRef.current = null;
      void runGenerate(current.text, undefined, current.html ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateKey, autoGenerate]);

  const close = useCallback(() => {
    // Stop an in-flight stream so it can't write state after dismissal.
    abortRef.current?.abort();
    adapter.close();
  }, [adapter, abortRef]);

  const handleVerdict = useCallback(
    (verdict: { ok: true } | { ok: false; text: string; html: string | null; metrics?: InsertFailureMetrics }) => {
      if (verdictTimer.current) clearTimeout(verdictTimer.current);
      if (verdict.ok) {
        close();
        return;
      }
      // Host could not apply the rewrite (panel stays open by design).
      setFailedText(verdict.text);
      setFailedHtml(typeof verdict.html === "string" ? verdict.html : null);
      setFailedMetrics(describeInsertMetrics(verdict.metrics ?? {}));
      setCopied(false);
      setInserted(false);
    },
    [close],
  );

  const insertText = useCallback(
    async (text: string) => {
      if (!text) return;
      // Best-effort clipboard priming for the host's clipboard-paste tier:
      // the clipboard always holds this rewrite and never another app's
      // content. Never throws, never blocks the insert that follows.
      const prime = async (): Promise<void> => {
        try {
          await copyDomHtml(
            () => document.getElementById("jot-content") as ContentNodeLike | null,
            typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
            document,
            () => document.execCommand("copy"),
            prepareDomCopy,
          );
        } catch {
          // Best effort only; the insert below does not depend on it.
        }
      };
      const keyedMap = mapRef.current;
      if (keyedMap) {
        // Keyed flow: the host commits the map through the live instance;
        // `text` is the plain fallback and `html` the built preview HTML.
        await prime();
        const outcome = adapter.insert({ text, html: keyedHtml, map: keyedMap });
        setInserted(true);
        adapter.track("rewrite_applied", {
          site: siteRef.current,
          editorType: editorRef.current,
          confirmed: false,
        });
        if (insertedTimer.current) clearTimeout(insertedTimer.current);
        if (verdictTimer.current) clearTimeout(verdictTimer.current);
        if (verdictUnsub.current) {
          verdictUnsub.current();
          verdictUnsub.current = null;
        }
        if (outcome.kind === "await-verdict") {
          // Verified targets: the host closes on success and holds the
          // panel open (copy/retry UI) on failure — never auto-close under
          // an in-flight write. The settle timer backstops a dead host only.
          verdictUnsub.current = outcome.subscribe(handleVerdict);
          verdictTimer.current = setTimeout(() => adapter.close(), outcome.settleMs ?? 15000);
          return;
        }
        insertedTimer.current = setTimeout(() => adapter.close(), 700);
        return;
      }
      // Formatted output travels as both: plain text for simple fields and
      // the sanitized HTML fragment for rich ones. The host picks per
      // target; text-only hosts ignore `html` entirely. Keyed off the text
      // content so preview, copy, and insert always agree.
      const outputHtml = /<[a-zA-Z]/.test(text) ? adapter.sanitizeHtml(text) : null;
      const plain = outputHtml ? adapter.toPlainText(text, text) : text;
      await prime();
      adapter.insert({ text: plain, html: outputHtml });
      setInserted(true);
      // Host-confirmed only on verified paths; elsewhere the host insert
      // is effectively infallible, so record it as confirmed.
      adapter.track("rewrite_applied", { site: siteRef.current, editorType: editorRef.current, confirmed: true });
      if (insertedTimer.current) clearTimeout(insertedTimer.current);
      insertedTimer.current = setTimeout(() => adapter.close(), 700);
    },
    [adapter, keyedHtml, handleVerdict],
  );

  // Abort any in-flight stream when the card unmounts; clear timers.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (insertedTimer.current) clearTimeout(insertedTimer.current);
      if (verdictTimer.current) clearTimeout(verdictTimer.current);
      if (verdictUnsub.current) verdictUnsub.current();
    },
    [abortRef],
  );

  const copyFailedText = useCallback(async () => {
    if (!failedText) return;
    // Prefer the live preview DOM verbatim; fall back to state-derived HTML.
    const dom = await copyDomHtml(
      () => document.getElementById("jot-content") as ContentNodeLike | null,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
      prepareDomCopy,
    );
    const ok =
      dom !== false
        ? true
        : await copyHtml(
            failedHtml ?? keyedHtml,
            failedText,
            typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
            document,
            () => document.execCommand("copy"),
          );
    setCopied(ok);
    if (ok) {
      adapter.track("rewrite_copied", { site: siteRef.current, editorType: editorRef.current });
    }
  }, [adapter, failedText, failedHtml, keyedHtml]);

  const retryFailed = useCallback(() => {
    setFailedText(null);
    setFailedHtml(null);
    setCopied(false);
    generate(inputText);
  }, [generate, inputText]);

  // Helper text follows focus: result → replace/copy, tweak with input →
  // tweak, empty tweak box → invite.
  const [focusZone, setFocusZone] = useState<FocusZone>(null);
  const [copiedHint, setCopiedHint] = useState<"copied" | "unavailable" | null>(null);
  const copiedHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      setFocusZone(zoneForTarget(event.target));
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(
    () => () => {
      if (copiedHintTimer.current) clearTimeout(copiedHintTimer.current);
    },
    [],
  );

  const copyOutput = useCallback(async () => {
    if (!output) return;
    // Prefer the live preview DOM verbatim; fall back to state-derived HTML
    // (keyed build first, else tags carried by the output itself). Rich
    // editors paste HTML, plain fields take the block-aware plain
    // conversion (tags dropped).
    const dom = await copyDomHtml(
      () => document.getElementById("jot-content") as ContentNodeLike | null,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
      prepareDomCopy,
    );
    const outputHtml = keyedHtml ?? (/<[a-zA-Z]/.test(output) ? adapter.sanitizeHtml(output) : null);
    const plain = outputHtml ? adapter.toPlainText(output, output) : output;
    // Clipboard may be denied by the page's permissions policy. Degrade to
    // a notice, never block the insert path.
    const ok =
      dom !== false
        ? true
        : await copyHtml(
            outputHtml,
            plain,
            typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
            document,
            () => document.execCommand("copy"),
          );
    setCopiedHint(ok ? "copied" : "unavailable");
    if (ok) {
      adapter.track("rewrite_copied", { site: siteRef.current, editorType: editorRef.current });
    }
    if (copiedHintTimer.current) clearTimeout(copiedHintTimer.current);
    copiedHintTimer.current = setTimeout(() => setCopiedHint(null), 2000);
  }, [adapter, output, keyedHtml]);

  // Move keyboard focus into the card on open so arrows/Enter work
  // immediately. Focus lands on the result so Enter inserts it right away,
  // or on the feedback input when there is no result yet.
  const focusInitial = useCallback(() => {
    const content = document.getElementById("jot-content");
    (content ?? document.getElementById("jot-feedback"))?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(focusInitial, 150);
    return () => clearTimeout(t);
  }, [focusInitial]);

  // When a rewrite lands, move focus to the result so Enter inserts it with
  // no navigation, unless a tweak is being composed (inputText non-empty),
  // in which case stealing focus would interrupt typing.
  const inputTextRef = useRef(inputText);
  useEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);

  useEffect(() => {
    if (status !== "output" || !output) return;
    if (inputTextRef.current.trim()) return;
    document.getElementById("jot-content")?.focus();
  }, [status, output]);

  // Global keyboard contract (capture phase so Enter inside inputs is
  // always observed). Enforces a focus trap (Tab never leaves the card)
  // and Up/Down switches between the two sections (content → feedback).
  // While an error is shown, the error's action buttons take the content
  // slot so they stay reachable by keyboard.
  useEffect(() => {
    const getErrorActions = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>("[data-jot-error-actions] button"),
    ];

    const getSections = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const errorActions = getErrorActions();
      const content = errorActions[0] ?? document.getElementById("jot-content");
      const input = document.getElementById("jot-feedback");
      if (content) out.push(content);
      if (input) out.push(input);
      return out;
    };

    const getFocusables = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const settings = document.querySelector<HTMLElement>('[aria-label="Open settings"]');
      const closeBtn = document.querySelector<HTMLElement>('[aria-label="Close Jot"]');
      if (settings) out.push(settings);
      if (closeBtn) out.push(closeBtn);
      const errorActions = getErrorActions();
      if (errorActions.length > 0) {
        out.push(...errorActions);
        const input = document.getElementById("jot-feedback");
        if (input) out.push(input);
        return out;
      }
      return [...out, ...getSections()];
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "Tab") {
        const focusables = getFocusables();
        if (focusables.length === 0) return;
        const idx = el ? focusables.indexOf(el) : -1;
        const next = event.shiftKey
          ? focusables[(idx - 1 + focusables.length) % focusables.length]
          : focusables[(idx + 1) % focusables.length];
        event.preventDefault();
        next?.focus();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const sections = getSections();
        if (sections.length === 0) return;
        const idx = el ? sections.indexOf(el) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = sections[(idx + delta + sections.length) % sections.length];
        next?.focus();
        return;
      }

      if (event.key === "Enter" && event.shiftKey) {
        // Copy the rewrite without inserting (content focused only; the
        // tweak box keeps Shift+Enter submitting the tweak).
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("#jot-content") && output) {
          event.preventDefault();
          void copyOutput();
        }
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      if (!el) return;
      if (el.id === "jot-content") {
        // Apply the rewrite back into the source field.
        event.preventDefault();
        if (output) void insertText(output);
      } else if (el.id === "jot-feedback") {
        // Refetch with the current tweak instruction (no apply).
        event.preventDefault();
        if (!sourceRef.current.text.trim()) return;
        void generate(inputText);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [insertText, generate, close, inputText, output, copyOutput]);

  // Report compactness whenever content changes size so iframe hosts can
  // budget the panel. Compact until rewritten text lands.
  const compactRef = useRef(true);
  compactRef.current = !output;
  useEffect(() => {
    sizeReporter?.notify(compactRef.current);
  }, [status, output, inserted, error, sizeReporter]);

  useEffect(() => {
    if (!sizeReporter) return;
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => sizeReporter.notify(compactRef.current));
    observer.observe(root);
    return () => observer.disconnect();
  }, [sizeReporter]);

  // Sampled composer colors as CSS vars, applied only as a pair: a lone
  // bg or fg would pair a sampled color against a mismatched theme color.
  // Unset = theme styling untouched. Paired cards take the composer
  // background as their face so overlay and composer read as one.
  // Detached fullscreen cards always use the theme surface (no composer tint).
  const isFullscreen = appearance?.fullscreen === true;
  const composerBg = appearance?.composerBg ?? null;
  const composerFg = appearance?.composerFg ?? null;
  const paired = composerBg !== null && composerFg !== null && !isFullscreen;
  const overlayDark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const pageIsDark = appearance?.pageDark ?? overlayDark;
  const cardVars = {
    "--jot-shadow": pageIsDark ? "0 8px 30px rgb(255 255 255 / 0.14)" : "0 8px 30px rgb(0 0 0 / 0.18)",
    ...(appearance?.contentMax ? { "--jot-content-max": appearance.contentMax } : {}),
    ...(paired
      ? {
          "--jot-cbg": composerBg,
          "--jot-cfg": composerFg,
          "--jot-card-face": "var(--jot-cbg)",
        }
      : {}),
  } as CSSProperties;

  return (
    <Card
      ref={rootRef}
      style={cardVars}
      className={`jot-card-glow jot-assistant relative w-full overflow-visible${paired ? " jot-paired" : ""}${isFullscreen ? " jot-fullscreen-card" : ""}`}
    >
      <Card.Header className="items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <img src={adapter.logoSrc} alt="" className="size-5 rounded-md" />
          <span className="jot-chrome text-sm font-medium tracking-tight">Jot</span>
        </div>
        <div className="jot-chrome -mr-1 flex items-center gap-0.5">
          {inserted && (
            <Chip size="sm" color="success" variant="soft">
              <Check className="size-3" />
              Inserted
            </Chip>
          )}
          {showSettingsAction && (
            <Tooltip>
              <Tooltip.Trigger className="inline-flex">
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="rounded-lg"
                  aria-label="Open settings"
                  onPress={() => adapter.openSettings()}
                >
                  <SettingsIcon className="size-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>Settings</Tooltip.Content>
            </Tooltip>
          )}
          <Tooltip>
            <Tooltip.Trigger className="inline-flex">
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                className="rounded-lg"
                aria-label="Close Jot"
                onPress={close}
              >
                <X className="size-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Close</Tooltip.Content>
          </Tooltip>
        </div>
      </Card.Header>

      <Card.Content>
        {error ? (
          error.kind === "quota" ? (
            <div className="rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-xs" role="alert">
              <p className="mb-1 font-medium text-foreground">{errorMessage(error)}</p>
              {error.upgrade?.message && <p className="mb-2 text-muted">{error.upgrade.message}</p>}
              {error.quota && (
                <p className="mb-2 text-[11px] text-muted">
                  {error.quota.used} / {error.quota.limit} used
                  {error.quota.period ? ` · ${error.quota.period}` : ""}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2" data-jot-error-actions>
                {error.upgrade?.available && error.upgrade.redirectUri ? (
                  <UpgradeButton upgrade={error.upgrade} onUpgrade={(info) => adapter.openUpgrade(info)} />
                ) : null}
                <Button size="sm" variant="tertiary" onPress={() => adapter.openSettings()}>
                  Open settings
                </Button>
                {/* Retry intentionally hidden for quota. It would just 402 again. */}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-danger/30 bg-danger-soft/40 p-3 text-xs text-danger" role="alert">
              <p className="mb-2 font-medium">{errorMessage(error)}</p>
              <div className="flex items-center gap-2" data-jot-error-actions>
                <Button size="sm" variant="primary" onPress={() => adapter.openSettings()}>
                  Open settings
                </Button>
                <Button size="sm" variant="tertiary" onPress={() => void generate(inputText)}>
                  Retry
                </Button>
              </div>
            </div>
          )
        ) : failedText ? (
          <div className="rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-xs" role="alert">
            <p className="mb-1 font-medium text-foreground">
              Couldn&apos;t update the editor. Copy the rewrite, then paste it into the editor (⌘V / Ctrl+V).
            </p>
            <p className="jot-failed-text mb-2 break-words whitespace-pre-wrap text-muted">{failedText}</p>
            {failedMetrics && <p className="mb-2 text-[11px] text-muted">{failedMetrics}</p>}
            <div className="flex items-center gap-2" data-jot-error-actions>
              <Button size="sm" variant="primary" onPress={() => void copyFailedText()}>
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
              <Button size="sm" variant="tertiary" onPress={retryFailed}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <ContentBox output={output} status={status} htmlPreview={keyedHtml} sanitize={adapter.sanitizeHtml} />
        )}
        {(() => {
          const kind = selectHelperText({
            hasOutput: status === "output" && !!output,
            focusZone,
            hasTweakInput: !!inputText.trim(),
          });
          if (!kind) return null;
          return (
            <p className="jot-secondary flex items-center gap-1.5 px-1 text-[11px] text-muted">
              {copiedHint === "copied" ? (
                "Copied to clipboard"
              ) : copiedHint === "unavailable" ? (
                <>
                  Copy unavailable here. Use <Kbd>⏎</Kbd> to replace
                </>
              ) : kind === "replace" ? (
                <>
                  Hit <Kbd>⏎</Kbd> to use. Hit <Kbd>⇧</Kbd> + <Kbd>⏎</Kbd> to copy to clipboard.
                </>
              ) : kind === "tweak" ? (
                <>
                  <Kbd>⏎</Kbd> to tweak the output
                </>
              ) : (
                "Tell Jot what to change…"
              )}
            </p>
          );
        })()}
      </Card.Content>

      <Card.Footer>
        <FeedbackInput
          value={inputText}
          onChange={setInputText}
          onEnter={() => void generate(inputText)}
          disabled={status === "generating"}
          pending={status === "generating"}
          placeholder={
            status === "output" && output ? "Make it shorter, warmer, more direct..." : "What would you like to say?"
          }
        />
      </Card.Footer>
    </Card>
  );
}
