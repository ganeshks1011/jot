import { useOverlayState } from "@heroui/react";
import { Button } from "@heroui/react/button";
import { Chip } from "@heroui/react/chip";
import { Input } from "@heroui/react/input";
import { Modal } from "@heroui/react/modal";
import { Slider } from "@heroui/react/slider";
import { TextArea } from "@heroui/react/textarea";
import { Pencil, RefreshCw } from "lucide-react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { resolveProviderMeta, siteLabelFor, track } from "@/lib/analytics";
import { rewriteWithInstruction } from "@/lib/api";
import { DOMAIN_SUGGESTIONS, getDemoExamples, getStarter } from "@/lib/onboardingExamples";
import {
  buildCanonical,
  flushTeachState,
  getDefaultInstruction,
  loadTeachState,
  type SliderDimension,
  type SliderLevel,
  saveDomains,
  saveExample,
  savePrompt,
  saveSliders,
  sliderLevelToLabel,
} from "@/lib/personalization";
import { ProviderError } from "@/lib/providers";
import { saveApiKey } from "@/lib/storage";
import type { ContextDomain, PersonalizationContext, ProviderId } from "@/lib/types";

export interface TeachJotSectionHandle {
  /** Re-persist prompts, domains, examples, and legacy mirrors. */
  flush: () => Promise<boolean>;
}

export interface TeachJotSectionProps {
  ref?: Ref<TeachJotSectionHandle>;
  /** Gate automatic previews (onboarding passes step===2; options passes true). */
  active: boolean;
  /** Fetch a preview automatically on first activation (onboarding only). */
  autoPreview: boolean;
  /** Freshly typed provider credentials for the Rewrite key flush. */
  apiKeyFlush: {
    provider: ProviderId;
    apiKey: string;
    apiKeyError: string | null;
  };
}

const CONTEXTS: { id: PersonalizationContext; label: string; desc: string }[] = [
  { id: "default", label: "Default", desc: "Used everywhere" },
  { id: "email", label: "Email", desc: "Email" },
  { id: "text", label: "Text", desc: "Messages" },
  { id: "social", label: "Social", desc: "Posts & replies" },
  { id: "work", label: "Work", desc: "Work" },
];

/**
 * "Teach Jot how you write": context styles, example rewrite playground,
 * and style controls. Shared by onboarding and options with instant-save
 * semantics: prompts persist per change, domains per edit, examples on
 * Rewrite. The host calls flush() only where an explicit save step exists
 * (onboarding Save & continue).
 */
export default function TeachJotSection({ ref, active, autoPreview, apiKeyFlush }: TeachJotSectionProps) {
  const [ctx, setCtx] = useState<PersonalizationContext>("default");
  const [contextPrompts, setContextPrompts] = useState<Record<PersonalizationContext, string>>({
    default: "",
    email: "",
    text: "",
    social: "",
    work: "",
  });
  const [contextDomains, setContextDomainsState] = useState<ContextDomain[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [showDomainSuggest, setShowDomainSuggest] = useState(false);
  const exampleModal = useOverlayState();
  const [jotResult, setJotResult] = useState("");
  const [generating, setGenerating] = useState(false);
  const [freeform, setFreeform] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedText, setAdvancedText] = useState("");
  const [remember, setRemember] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const previewCacheRef = useRef<Map<string, string>>(new Map());
  const [lastPreviewKey, setLastPreviewKey] = useState<string | null>(null);
  const hasFetchedInitialRef = useRef(false);
  const [exampleOverrides, setExampleOverrides] = useState<Record<PersonalizationContext, string>>({
    default: "",
    email: "",
    text: "",
    social: "",
    work: "",
  });
  const [sliders, setSliders] = useState<
    Record<PersonalizationContext, { casual: SliderLevel; direct: SliderLevel; length: SliderLevel }>
  >({
    default: { casual: 3, direct: 3, length: 3 },
    email: { casual: 3, direct: 3, length: 3 },
    text: { casual: 3, direct: 3, length: 3 },
    social: { casual: 3, direct: 3, length: 3 },
    work: { casual: 3, direct: 3, length: 3 },
  });
  const [isEditingRewrite, setIsEditingRewrite] = useState(false);
  const [draftRewrite, setDraftRewrite] = useState("");

  // Load existing config (seeding handled inside the store)
  useEffect(() => {
    void (async () => {
      const state = await loadTeachState();
      setContextPrompts(state.prompts);
      setSliders(state.sliders);
      setContextDomainsState(state.domains);
      setExampleOverrides(state.examples);
      // Advanced shows current ctx prompt
      setAdvancedText(state.prompts.default || getDefaultInstruction());
    })();
  }, []);

  // Helpers for personalization flow
  const getCurrentInstruction = useCallback(
    (c: PersonalizationContext) => {
      const direct = contextPrompts[c]?.trim();
      if (direct) return direct;
      if (c !== "default") {
        const def = contextPrompts.default?.trim();
        if (def) return def;
      }
      return getDefaultInstruction();
    },
    [contextPrompts],
  );

  const getExampleText = useCallback(
    (c: PersonalizationContext) => {
      // After seeding, override is always defined; empty "" means user cleared → show placeholder (empty string)
      const o = exampleOverrides[c];
      if (o !== undefined && o !== null) return o;
      return getStarter(c, 0);
    },
    [exampleOverrides],
  );

  const siteForCtx = useCallback(
    (c: PersonalizationContext) => {
      if (c === "default") return undefined;
      const d = contextDomains.find((x) => x.context === c);
      return d?.pattern;
    },
    [contextDomains],
  );

  const buildPreviewCacheKey = useCallback(
    (c: PersonalizationContext, instruction: string) => {
      // Trimmed: trailing-space edits must not fork the cache from the
      // trimmed value actually persisted and sent.
      const ex = getExampleText(c).trim();
      const site = siteForCtx(c) ?? "";
      return `${c}||${ex}||${site}||${instruction.trim()}`;
    },
    [getExampleText, siteForCtx],
  );

  const triggerPreview = useCallback(
    async (c: PersonalizationContext, instruction: string, opts?: { showLoader?: boolean; force?: boolean }) => {
      const key = buildPreviewCacheKey(c, instruction);
      const cached = previewCacheRef.current.get(key);
      // Explicit Rewrite (force) always fetches; silent cache serves only
      // automatic previews so Rewrite never looks dead (no glimmer/network).
      if (cached && !opts?.force) {
        setJotResult(cached);
        setLastPreviewKey(key);
        setHint(null);
        return;
      }
      const showLoader = opts?.showLoader ?? true;
      const ex = getExampleText(c);
      const site = siteForCtx(c);
      if (showLoader) setGenerating(true);
      setHint(null);
      const meta = {
        site: siteLabelFor(site),
        ...(await resolveProviderMeta()),
      };
      const t0 = performance.now();
      void track("rewrite_started", meta);
      try {
        const res = await rewriteWithInstruction(ex, instruction, site);
        previewCacheRef.current.set(key, res);
        setLastPreviewKey(key);
        setJotResult(res);
        void track("rewrite_completed", {
          ...meta,
          success: true,
          duration_ms: Math.round(performance.now() - t0),
        });
      } catch (err) {
        const msg =
          err instanceof ProviderError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Could not generate example";
        // Preserve prompt change; show retry hint
        setHint(msg);
        void track("rewrite_failed", {
          ...meta,
          success: false,
          error_type: err instanceof ProviderError ? err.kind : "unknown",
          duration_ms: Math.round(performance.now() - t0),
        });
      } finally {
        if (showLoader) setGenerating(false);
      }
    },
    [buildPreviewCacheKey, getExampleText, siteForCtx],
  );

  const handleRewrite = useCallback(
    async (c: PersonalizationContext) => {
      // Flush a freshly typed API key first: the autosave debounce (400ms)
      // may not have persisted it yet when Rewrite is tapped immediately.
      const { provider, apiKey, apiKeyError } = apiKeyFlush;
      if (provider !== "jot-api" && apiKey.trim() && !apiKeyError) {
        await saveApiKey(apiKey.trim(), provider);
      }
      // Persist edited example only on explicit rewrite (user request)
      const edited = exampleOverrides[c]?.trim() ?? "";
      if (edited) await saveExample(c, edited);
      else {
        // If user cleared override, remove persisted entry so starter is used
        const cur = exampleOverrides[c];
        if (cur !== "") await saveExample(c, "");
      }
      setIsEditingRewrite(false);
      await triggerPreview(c, getCurrentInstruction(c), { showLoader: true, force: true });
    },
    [apiKeyFlush, exampleOverrides, getCurrentInstruction, triggerPreview],
  );

  // Keep advanced editor in sync with current context prompt
  useEffect(() => {
    setAdvancedText(getCurrentInstruction(ctx));
  }, [ctx, getCurrentInstruction]);

  // Preview generation: only auto-fetch on first activation when enabled.
  // After that, serve cached results silently and keep the last rewrite visible;
  // new combinations require an explicit Rewrite tap (stale hint shown below).
  useEffect(() => {
    if (!active) return;
    if (autoPreview && !hasFetchedInitialRef.current) {
      hasFetchedInitialRef.current = true;
      void triggerPreview(ctx, getCurrentInstruction(ctx), { showLoader: true });
      return;
    }
    const key = buildPreviewCacheKey(ctx, getCurrentInstruction(ctx));
    const hit = previewCacheRef.current.get(key);
    if (hit) {
      setJotResult(hit);
      setLastPreviewKey(key);
      setHint(null);
    }
  }, [active, autoPreview, ctx, getCurrentInstruction, buildPreviewCacheKey, triggerPreview]);

  // Keep draftRewrite in sync with fetched result when not editing
  useEffect(() => {
    if (!isEditingRewrite) setDraftRewrite(jotResult);
  }, [jotResult, isEditingRewrite]);

  // Revert manual rewrite edits on context switch (tab switch)
  useEffect(() => {
    setIsEditingRewrite(false);
    // draft will be repopulated from jotResult via effect above
  }, [ctx]);

  const handleExampleChange = useCallback((c: PersonalizationContext, val: string) => {
    setExampleOverrides((prev) => ({ ...prev, [c]: val }));
    // Persist only on Rewrite / flush (see handleRewrite / flush)
  }, []);

  const persistPromptForCtx = useCallback(async (c: PersonalizationContext, prompt: string) => {
    setContextPrompts((prev) => ({ ...prev, [c]: prompt }));
    await savePrompt(c, prompt);
  }, []);

  const handleSliderCommit = useCallback(
    async (dimension: SliderDimension, level: SliderLevel) => {
      // Positions persist as levels; directives compile at rewrite time.
      const next = { ...sliders[ctx], [dimension]: level };
      setSliders((prev) => ({ ...prev, [ctx]: next }));
      await saveSliders(ctx, next);
      setRemember(true);
      setTimeout(() => setRemember(false), 2500);
    },
    [ctx, sliders],
  );

  const handleSliderChange = useCallback(
    (dimension: SliderDimension, level: SliderLevel) => {
      setSliders((prev) => ({ ...prev, [ctx]: { ...prev[ctx], [dimension]: level } }));
    },
    [ctx],
  );

  const handleFreeform = useCallback(async () => {
    const txt = freeform.trim();
    if (!txt || generating) return;
    const base = getCurrentInstruction(ctx);
    const next = buildCanonical(base, txt);
    await persistPromptForCtx(ctx, next);
    setAdvancedText(next);
    setFreeform("");
    setRemember(true);
    setTimeout(() => setRemember(false), 2500);
  }, [freeform, ctx, generating, getCurrentInstruction, persistPromptForCtx]);

  const handleExamplePick = useCallback(
    (input: string) => {
      setExampleOverrides((prev) => ({ ...prev, [ctx]: input }));
      setIsEditingRewrite(false);
      exampleModal.close();
    },
    [ctx, exampleModal],
  );

  const modalExamples = useMemo(() => getDemoExamples(ctx), [ctx]);
  const modalContextLabel = CONTEXTS.find((c) => c.id === ctx)?.label ?? ctx;
  const currentPreviewKey = buildPreviewCacheKey(ctx, getCurrentInstruction(ctx));
  const isPreviewStale =
    Boolean(jotResult) && !generating && lastPreviewKey !== null && currentPreviewKey !== lastPreviewKey;

  const handleDomainAdd = useCallback(async () => {
    const raw = domainInput.trim().toLowerCase();
    if (!raw || ctx === "default") return;
    // Allow "All email" sentinel? store as actual pattern.
    const pattern = raw.replace(/^https?:\/\//, "");
    if (!pattern) return;
    // Basic validation: must look like domain
    if (!pattern.includes(".") || pattern.includes(" ")) {
      setHint(`Enter a valid domain like gmail.com`);
      return;
    }
    const exists = contextDomains.some((d) => d.context === ctx && d.pattern === pattern);
    if (exists) {
      setDomainInput("");
      setShowDomainSuggest(false);
      return;
    }
    const next = [...contextDomains, { context: ctx as Exclude<PersonalizationContext, "default">, pattern }];
    setContextDomainsState(next);
    await saveDomains(next);
    setDomainInput("");
    setShowDomainSuggest(false);
    setHint(null);
  }, [domainInput, ctx, contextDomains]);

  const handleDomainRemove = useCallback(
    async (pattern: string) => {
      const next = contextDomains.filter((d) => !(d.context === ctx && d.pattern === pattern));
      setContextDomainsState(next);
      await saveDomains(next);
    },
    [ctx, contextDomains],
  );

  const handleDomainSuggestion = useCallback(
    async (pattern: string) => {
      const clean = pattern.trim().toLowerCase();
      const exists = contextDomains.some((d) => d.context === ctx && d.pattern === clean);
      if (exists) return;
      const next = [...contextDomains, { context: ctx as Exclude<PersonalizationContext, "default">, pattern: clean }];
      setContextDomainsState(next);
      await saveDomains(next);
      setDomainInput("");
      setShowDomainSuggest(false);
    },
    [ctx, contextDomains],
  );

  const handleAdvancedSave = useCallback(async () => {
    const txt = advancedText.trim() || getDefaultInstruction();
    await persistPromptForCtx(ctx, txt);
    setShowAdvanced(false);
    setRemember(true);
    setTimeout(() => setRemember(false), 2500);
  }, [advancedText, ctx, persistPromptForCtx]);

  const handleAdvancedReset = useCallback(async () => {
    const def = getDefaultInstruction();
    setAdvancedText(def);
    await persistPromptForCtx(ctx, def);
    setRemember(true);
    setTimeout(() => setRemember(false), 2500);
  }, [ctx, persistPromptForCtx]);

  const flush = useCallback(async () => {
    try {
      await flushTeachState({
        prompts: contextPrompts,
        sliders,
        domains: contextDomains,
        examples: exampleOverrides,
      });
      return true;
    } catch {
      setHint("Could not save prompts");
      return false;
    }
  }, [contextPrompts, sliders, contextDomains, exampleOverrides]);

  useImperativeHandle(ref, () => ({ flush }), [flush]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-jot text-base font-semibold">Teach Jot how you write</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Try an example. Make a few changes. Jot will remember your preferences.
        </p>
      </div>

      <div role="tablist" aria-label="Writing context" className="flex gap-1.5 overflow-x-auto scrollbar-thin pb-1">
        {CONTEXTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={ctx === c.id}
            onClick={() => setCtx(c.id)}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
              ctx === c.id
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-surface text-muted hover:bg-surface-secondary"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      {ctx === "default" ? (
        <p className="text-[11px] text-muted">Used everywhere</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted">Use this style on</p>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface-secondary/40 p-2">
            {contextDomains
              .filter((d) => d.context === ctx)
              .map((d) => (
                <Chip key={`${d.context}:${d.pattern}`} size="sm" variant="soft" color="default" className="gap-1">
                  {d.pattern}
                  <button
                    type="button"
                    onClick={() => void handleDomainRemove(d.pattern)}
                    aria-label={`Remove ${d.pattern}`}
                    className="ml-1 rounded-full p-0.5 hover:bg-default-200"
                  >
                    ×
                  </button>
                </Chip>
              ))}
            <div className="relative flex min-w-[140px] flex-1 items-center">
              <Input
                aria-label="Add website"
                value={domainInput}
                onChange={(e) => {
                  setDomainInput(e.target.value);
                  setShowDomainSuggest(true);
                }}
                onFocus={() => setShowDomainSuggest(true)}
                onBlur={() => setTimeout(() => setShowDomainSuggest(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleDomainAdd();
                  }
                }}
                placeholder={ctx === "email" ? "gmail.com" : ctx === "work" ? "linkedin.com" : "slack.com"}
                className="h-7 min-w-0 border-0 bg-transparent p-0 text-xs shadow-none focus:ring-0"
              />
              {showDomainSuggest && domainInput.trim() && (
                <div className="absolute left-0 top-full z-10 mt-1 max-h-32 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg">
                  {DOMAIN_SUGGESTIONS.filter(
                    (s) =>
                      s.toLowerCase().includes(domainInput.trim().toLowerCase()) &&
                      !contextDomains.some((d) => d.context === ctx && d.pattern === s),
                  )
                    .slice(0, 6)
                    .map((s) => (
                      <button
                        key={s}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          void handleDomainSuggestion(s);
                        }}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-secondary"
                      >
                        {s}
                      </button>
                    ))}
                  {(() => {
                    const typed = domainInput.trim().toLowerCase();
                    const already =
                      contextDomains.some((d) => d.context === ctx && d.pattern === typed) ||
                      DOMAIN_SUGGESTIONS.includes(typed);
                    const valid = typed.includes(".") && !typed.includes(" ") && typed.length >= 4;
                    if (typed && valid && !already) {
                      return (
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            void handleDomainAdd();
                          }}
                          className="w-full border-t border-border px-3 py-1.5 text-left text-xs font-medium text-accent hover:bg-surface-secondary"
                        >
                          Add “{typed}”
                        </button>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}
            </div>
            <Button size="sm" variant="tertiary" onPress={() => void handleDomainAdd()}>
              Add website
            </Button>
          </div>
          {contextPrompts[ctx]?.trim() ? null : (
            <p className="text-[11px] text-muted">Starts with your Default style</p>
          )}
          {(() => {
            const tags = contextDomains.filter((d) => d.context === ctx);
            if (tags.length === 0)
              return (
                <p className="text-[11px] text-muted">
                  All {CONTEXTS.find((c) => c.id === ctx)?.label.toLowerCase()}. Or add a specific site above.
                </p>
              );
            return null;
          })()}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted">Example</p>
          <button
            type="button"
            onClick={() => exampleModal.open()}
            className="text-[11px] font-medium text-accent hover:underline"
          >
            Try another example
          </button>
        </div>
        <Modal.Root state={exampleModal}>
          <Modal.Backdrop>
            <Modal.Container size="lg" placement="center">
              <Modal.Dialog aria-label={`Choose an example for ${modalContextLabel}`}>
                <Modal.Header>
                  <Modal.Heading>Choose an example: {modalContextLabel}</Modal.Heading>
                  <Modal.CloseTrigger aria-label="Close examples" />
                </Modal.Header>
                <Modal.Body>
                  <p className="text-xs leading-relaxed text-muted">
                    Examples for {modalContextLabel}. Pick one to edit and rewrite.
                  </p>
                  <div className="flex flex-col gap-2">
                    {modalExamples.map((ex) => (
                      <button
                        key={ex.title}
                        type="button"
                        onClick={() => handleExamplePick(ex.input)}
                        className="rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition hover:bg-surface-secondary"
                      >
                        <p className="text-sm font-medium">{ex.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted dark:text-muted">
                          {ex.input}
                        </p>
                      </button>
                    ))}
                  </div>
                </Modal.Body>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal.Root>
        <TextArea
          aria-label="Example"
          value={getExampleText(ctx)}
          onChange={(e) => handleExampleChange(ctx, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === " ") e.stopPropagation();
          }}
          placeholder="Type your example…"
          variant="secondary"
          className="min-h-20 w-full resize-y"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            onPress={() => void handleRewrite(ctx)}
            isDisabled={generating}
            aria-label={`Rewrite ${ctx} example`}
          >
            <RefreshCw className={`size-3.5 ${generating ? "animate-spin" : ""}`} /> Rewrite
          </Button>
        </div>
        <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[11px] font-medium text-muted">Jot’s rewrite</p>
            {!generating && jotResult && !isEditingRewrite && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() => {
                  setDraftRewrite(jotResult);
                  setIsEditingRewrite(true);
                }}
                aria-label="Edit rewrite"
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
          </div>
          {generating ? (
            <div className="flex flex-col gap-2 py-1" role="status" aria-live="polite" aria-busy="true">
              <div className="h-3 w-4/5 animate-pulse rounded bg-default-200" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-default-200" />
            </div>
          ) : isEditingRewrite ? (
            <div className="flex flex-col gap-2">
              <TextArea
                aria-label="Edit rewrite"
                value={draftRewrite}
                onChange={(e) => setDraftRewrite(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === " ") e.stopPropagation();
                }}
                variant="secondary"
                className="min-h-20 w-full resize-y"
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setIsEditingRewrite(false);
                    setDraftRewrite(jotResult);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onPress={() => {
                    setJotResult(draftRewrite);
                    setIsEditingRewrite(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : jotResult ? (
            <p className="text-sm leading-relaxed">{jotResult}</p>
          ) : (
            <p className="text-sm italic text-muted">Jot will rewrite here…</p>
          )}
        </div>
        {isPreviewStale && !hint && <p className="text-xs text-muted">Style changed. Tap Rewrite to preview</p>}
        {remember && <p className="text-xs font-medium text-success">✓ Jot will remember this</p>}
      </div>

      <div className="flex flex-col gap-3">
        {(
          [
            ["casual", "Casual ↔ Professional"],
            ["direct", "Direct ↔ Gentle"],
            ["length", "Short ↔ Detailed"],
          ] as const
        ).map(([dim, label]) => (
          <Slider
            key={dim}
            minValue={1}
            maxValue={5}
            step={1}
            value={[sliders[ctx][dim as SliderDimension]]}
            onChange={(v: number | number[]) => {
              const val = Array.isArray(v) ? v[0] : v;
              handleSliderChange(dim as SliderDimension, val as SliderLevel);
            }}
            onChangeEnd={(v: number | number[]) => {
              const val = Array.isArray(v) ? v[0] : v;
              void handleSliderCommit(dim as SliderDimension, val as SliderLevel);
            }}
            isDisabled={generating}
            aria-label={label}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted">{label}</span>
              <span className="text-[11px] font-medium">
                {sliderLevelToLabel(dim as SliderDimension, sliders[ctx][dim as SliderDimension])}
              </span>
            </div>
            <Slider.Track className="mt-1">
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Tell Jot what you prefer"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleFreeform();
              }
            }}
            placeholder="Tell Jot what you prefer..."
            fullWidth
            variant="secondary"
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={!freeform.trim() || generating}
          onPress={() => void handleFreeform()}
        >
          Try it
        </Button>
      </div>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted hover:text-foreground hover:underline"
        >
          Advanced: Edit instructions
        </button>
      </div>

      {showAdvanced && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-secondary/30 p-3">
          <p className="text-sm font-medium">Instructions for Jot</p>
          <TextArea
            aria-label="Instructions for Jot"
            value={advancedText}
            onChange={(e) => setAdvancedText(e.target.value)}
            placeholder="Instructions for this context..."
            className="min-h-24 w-full resize-y scrollbar-thin"
            variant="secondary"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="tertiary" onPress={() => void handleAdvancedReset()}>
              Reset to Jot’s default
            </Button>
            <Button size="sm" variant="primary" onPress={() => void handleAdvancedSave()}>
              Done
            </Button>
          </div>
          <p className="text-[11px] text-muted">Editing here updates the same style used above.</p>
        </div>
      )}

      {hint && (
        <p className="text-xs text-danger" role="alert">
          {hint}
        </p>
      )}
    </div>
  );
}
