import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Input } from "@heroui/react/input";
import { Kbd } from "@heroui/react/kbd";
import { TextArea } from "@heroui/react/textarea";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import TeachJotSection, { type TeachJotSectionHandle } from "@/components/TeachJotSection";
import { useWurkfloLink } from "@/hooks/useWurkfloLink";
import { type OnboardingStepName, track } from "@/lib/analytics";
import { listModels } from "@/lib/api";
import { watchWurkfloAuth } from "@/lib/auth";
import { validateCustomProvider } from "@/lib/customProvider";
import {
  getAdapter,
  getAllAdapters,
  getRecommendedModels,
  OPENAI_ENDPOINT_PRESETS,
  ProviderError,
} from "@/lib/providers";
import { isRetiredModel } from "@/lib/providers/openai";
import { validateApiKey } from "@/lib/providerValidation";
import {
  clearPendingLinkCode,
  DEFAULT_BACKEND,
  getApiKey,
  getBackendConfig,
  getCustomProviders,
  getPendingLinkCode,
  getTheme,
  getWurkfloRemaining,
  getWurkfloUser,
  saveApiKey,
  saveBackendConfig,
  saveTheme,
  setOnboarded,
  upsertCustomProvider,
  type WurkfloUserSnapshot,
  watchPendingLinkCode,
  watchTheme,
  watchWurkfloUser,
} from "@/lib/storage";

const STEP_NAMES: OnboardingStepName[] = ["welcome", "provider", "personalization", "done"];

import type { ProviderId, ThemeId } from "@/lib/types";

const PLAYGROUND_URL = "https://wurkflo.app/jot/playground";

export default function Onboarding() {
  // Extension page view (onboarding). Fires once on mount.
  useEffect(() => {
    void track("page_view", {
      page_title: document.title,
      page_location: location.href,
    });
  }, []);

  const [step, setStep] = useState(0);
  const totalSteps = 4;
  const teachJotRef = useRef<TeachJotSectionHandle | null>(null);

  // Provider
  const [provider, setProvider] = useState<ProviderId>(DEFAULT_BACKEND.provider);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providerOptions, setProviderOptions] = useState(() => getAllAdapters());
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customApiKeyUrl, setCustomApiKeyUrl] = useState("");
  const [customHeadersText, setCustomHeadersText] = useState("");

  const refreshProviders = useCallback(async () => {
    await getCustomProviders();
    setProviderOptions(getAllAdapters());
  }, []);

  // Validate API key per provider and auto-save debounced
  useEffect(() => {
    const err = validateApiKey(provider, apiKey, baseUrl);
    setApiKeyError(err);
    if (provider === "jot-api") return;
    if (!apiKey.trim()) return;
    if (err) return;
    const t = setTimeout(() => void saveApiKey(apiKey.trim(), provider), 400);
    return () => clearTimeout(t);
  }, [provider, apiKey, baseUrl]);

  useEffect(() => {
    if (isRetiredModel(model)) {
      setModelError("This model is retired. Use gemini-3.5-flash-lite");
    } else setModelError(null);
  }, [model]);

  const [theme, setTheme] = useState<ThemeId>("system");

  useEffect(() => {
    void getTheme().then(setTheme);
    const unsub = watchTheme(setTheme);
    return unsub;
  }, []);

  const handleThemeChange = useCallback((v: ThemeId) => {
    setTheme(v);
    void saveTheme(v);
  }, []);

  // Wurkflo
  const [wurkfloUser, setWurkfloUser] = useState<WurkfloUserSnapshot | null>(null);
  const [wurkfloRemaining, setWurkfloRemainingState] = useState<number | null>(null);
  const {
    linking,
    linkError,
    handleConnect: handleWurkfloConnect,
    handleSignOut: handleWurkfloSignOut,
  } = useWurkfloLink();

  const isProviderReady = useMemo(() => {
    if (provider === "jot-api") return !!wurkfloUser;
    if (apiKey.trim()) return true;
    const lowerBase = baseUrl.trim().toLowerCase();
    if (lowerBase.includes("localhost") || lowerBase.includes("127.0.0.1")) return true;
    return false;
  }, [provider, apiKey, wurkfloUser, baseUrl]);

  // Load existing config
  useEffect(() => {
    void (async () => {
      const cfg = await getBackendConfig();
      const [key, wUser, wRem] = await Promise.all([getApiKey(cfg.provider), getWurkfloUser(), getWurkfloRemaining()]);
      setProvider(cfg.provider);
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setApiKey(key);
      setWurkfloUser(wUser);
      setWurkfloRemainingState(wRem);
      setProviderOptions(getAllAdapters());
    })();
    const unsubW = watchWurkfloUser(setWurkfloUser);
    const unsubAuth = watchWurkfloAuth();
    return () => {
      unsubW();
      unsubAuth();
    };
  }, []);

  const selectProvider = useCallback((id: ProviderId) => {
    const adapter = getAdapter(id);
    if (!adapter) return;
    setProvider(id);
    setBaseUrl(adapter.defaultBaseUrl);
    setModel(adapter.defaultModel);
    setModels([]);
    setHint(null);
    void getApiKey(id).then((k) => setApiKey(k));
  }, []);

  const handleAddCustomProvider = useCallback(async () => {
    const validated = validateCustomProvider({
      label: customLabel,
      baseUrl: customBaseUrl,
      model: customModel,
      apiKeyUrl: customApiKeyUrl,
      headersText: customHeadersText,
    });
    if (validated.error) {
      setHint(validated.error);
      return;
    }
    const meta = validated.meta!;
    try {
      await upsertCustomProvider(meta);
      await refreshProviders();
      const adapter = getAdapter(meta.id);
      if (adapter) {
        setProvider(meta.id);
        setBaseUrl(adapter.defaultBaseUrl);
        setModel(adapter.defaultModel);
        setApiKey("");
        setModels([]);
      }
      setShowCustomForm(false);
      setCustomLabel("");
      setCustomBaseUrl("");
      setCustomModel("");
      setCustomApiKeyUrl("");
      setCustomHeadersText("");
      setHint(null);
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Could not add provider");
    }
  }, [customLabel, customBaseUrl, customModel, customApiKeyUrl, customHeadersText, refreshProviders]);

  const loadModels = useCallback(async () => {
    const err = validateApiKey(provider, apiKey, baseUrl);
    if (err) {
      setHint(err);
      setApiKeyError(err);
      return;
    }
    if (apiKey.trim()) await saveApiKey(apiKey.trim(), provider);
    setLoadingModels(true);
    setHint(null);
    try {
      const list = await listModels({ provider, baseUrl, model, apiKey });
      setModels(list);
      const first = list[0];
      if (first && !list.includes(model)) setModel(first);
    } catch (err) {
      setHint(err instanceof ProviderError ? err.message : "Could not load models");
    } finally {
      setLoadingModels(false);
    }
  }, [model, provider, apiKey, baseUrl]);

  const saveProvider = useCallback(async () => {
    if (!isProviderReady) {
      setHint(provider === "jot-api" ? "Connect to Wurkflo to continue." : "Enter your API key to continue.");
      return false;
    }
    if (isRetiredModel(model)) {
      setHint(modelError ?? "This model is retired. Use gemini-3.5-flash-lite");
      return false;
    }
    setSaving(true);
    setHint(null);
    try {
      const adapter = getAdapter(provider);
      if (!adapter) throw new Error(`Unknown provider "${provider}"`);
      await saveBackendConfig({
        provider,
        baseUrl: baseUrl.trim() || adapter.defaultBaseUrl,
        model: model.trim() || adapter.defaultModel,
      });
      await saveApiKey(apiKey.trim(), provider);
      return true;
    } catch {
      setHint("Could not save provider settings");
      return false;
    } finally {
      setSaving(false);
    }
  }, [provider, baseUrl, model, apiKey, isProviderReady]);

  // Funnel: one event per step view (forward, Back, and redirects).
  useEffect(() => {
    const stepName = STEP_NAMES[step];
    if (stepName) void track("onboarding_step_viewed", { step, step_name: stepName });
  }, [step]);

  const finishOnboarding = useCallback(async () => {
    if (!isProviderReady) {
      setHint("Connect a provider to continue. Choose Wurkflo or enter an API key.");
      setStep(1);
      return;
    }
    await setOnboarded(true);
    void track("onboarding_completed", {});
    void browser.tabs.create({ url: PLAYGROUND_URL });
    window.close();
  }, [isProviderReady]);

  const next = async () => {
    if (step === 1) {
      const ok = await saveProvider();
      if (!ok) return;
    }
    if (step === 2) {
      setSaving(true);
      const ok = (await teachJotRef.current?.flush()) ?? true;
      setSaving(false);
      if (!ok) return;
    }
    if (step < totalSteps - 1) setStep((s) => s + 1);
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <main className="flex min-h-screen items-start justify-center bg-background p-6">
      <div className="w-full max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={browser.runtime.getURL("/icon/icon128.png")} alt="" className="size-9 rounded-xl shadow-sm" />
            <div>
              <h1 className="font-jot text-lg font-semibold tracking-tight">Welcome to Jot</h1>
              <p className="text-xs text-muted">
                Step {step + 1} of {totalSteps}
              </p>
            </div>
          </div>
          <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex items-center rounded-full border border-border bg-surface-secondary/60 p-0.5"
          >
            {(
              [
                ["light", Sun, "Light"],
                ["system", Monitor, "System"],
                ["dark", Moon, "Dark"],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                aria-label={label}
                onClick={() => handleThemeChange(id as ThemeId)}
                className={`inline-flex items-center justify-center rounded-full p-1.5 transition ${
                  theme === id ? "bg-accent text-accent-foreground shadow-sm" : "text-muted hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </header>

        <div data-progress={step} className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-default-200">
          <div className="bar h-full bg-accent transition-all duration-300" />
        </div>

        <Card className="border border-border bg-surface p-6 shadow-surface">
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <h2 className="font-jot text-xl font-semibold tracking-tight">Write it rough. Jot it right.</h2>
              <p className="text-sm leading-relaxed text-muted">
                Jot rewrites the text you’ve selected inside any page: replies, comments, posts, announcements. It works
                where you already write, with no standing access to websites until you press the shortcut.
              </p>
              <div className="rounded-xl border border-border bg-surface-secondary/60 p-4 text-sm">
                <p className="font-medium">How it works</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
                  <li>Select text or focus an editable field</li>
                  <li>Press the shortcut to open Jot</li>
                  <li>Pick a mode, tweak, and press Enter to insert</li>
                </ol>
              </div>
              <p className="text-xs text-muted">Takes about 2 minutes to set up.</p>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="font-jot text-base font-semibold">Choose your AI provider</h2>
                <p className="mt-1 text-xs text-muted">Wurkflo gives 100 free rewrites/mo. Or bring your own key.</p>
              </div>

              <div role="radiogroup" aria-label="AI provider" className="flex flex-col gap-2">
                {providerOptions.map((a) => {
                  const selected = provider === a.id;
                  return (
                    <div key={a.id} className="flex flex-col gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => selectProvider(a.id as ProviderId)}
                        className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left transition ${
                          selected
                            ? "border-accent bg-accent-soft/30"
                            : "border-border bg-surface-secondary/40 hover:bg-surface-secondary/60"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{a.label}</p>
                          <p className="truncate text-xs text-muted">
                            {a.id === "jot-api" ? "100 free/mo. No API key" : a.defaultBaseUrl}
                          </p>
                        </div>
                        <span
                          className={`ml-3 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                            selected ? "border-accent bg-accent" : "border-border bg-surface"
                          }`}
                        >
                          {selected && <span className="size-1.5 rounded-full bg-accent-foreground" />}
                        </span>
                      </button>
                      {selected && a.id === "jot-api" && (
                        <div className="rounded-xl border border-border bg-surface-secondary/50 p-4">
                          {wurkfloUser ? (
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <p className="truncate text-sm font-medium">{wurkfloUser.email}</p>
                                <p className="text-xs text-muted">
                                  {wurkfloRemaining === null
                                    ? "Signed in via Wurkflo"
                                    : `${wurkfloRemaining} of 100 free requests left`}
                                </p>
                              </div>
                              <Button size="sm" variant="secondary" onPress={() => void handleWurkfloSignOut()}>
                                <LogOut className="size-3.5" />
                                Sign out
                              </Button>
                            </div>
                          ) : (
                            <>
                              <p className="text-sm font-medium">Connect Jot Rewrite API from Wurkflo</p>
                              <p className="mt-1 text-xs text-muted">
                                No API key needed. Opens wurkflo.app to approve.
                              </p>
                              <Button size="sm" variant="primary" onPress={handleWurkfloConnect} className="mt-3">
                                <LogIn className="size-3.5" />
                                Connect Jot Rewrite API from Wurkflo
                              </Button>
                              {linking && (
                                <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted">
                                  <Loader2 className="size-3 animate-spin" /> Finishing…
                                </p>
                              )}
                              {linkError && <p className="mt-2 text-xs text-danger">{linkError}</p>}
                            </>
                          )}
                        </div>
                      )}
                      {selected && a.id !== "jot-api" && (
                        <>
                          <div>
                            <p className="mb-1 text-xs font-medium text-muted">Base URL</p>
                            <Input
                              aria-label="Base URL"
                              value={baseUrl}
                              onChange={(e) => setBaseUrl(e.target.value)}
                              placeholder={getAdapter(provider)?.defaultBaseUrl ?? "https://.../v1"}
                              fullWidth
                              variant="secondary"
                            />
                            {provider === "openai" && (
                              <div className="mt-2">
                                <div className="flex flex-wrap gap-1.5">
                                  {OPENAI_ENDPOINT_PRESETS.map((p) => (
                                    <Button
                                      key={p.baseUrl}
                                      size="sm"
                                      variant={baseUrl.trim() === p.baseUrl ? "primary" : "tertiary"}
                                      onPress={() => setBaseUrl(p.baseUrl)}
                                    >
                                      {p.label}
                                    </Button>
                                  ))}
                                </div>
                                <p className="mt-1 text-[11px] text-muted">
                                  Pick an endpoint, paste your key, then Load models.
                                </p>
                              </div>
                            )}
                          </div>
                          <div className="flex items-end gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="mb-1 text-xs font-medium text-muted">Model</p>
                              <Input
                                aria-label="Model"
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                                placeholder={getAdapter(provider)?.defaultModel ?? "model-name"}
                                fullWidth
                                variant="secondary"
                              />
                            </div>
                            <Button
                              size="sm"
                              variant="tertiary"
                              isPending={loadingModels}
                              onPress={() => void loadModels()}
                            >
                              <RefreshCw className="size-3.5" /> Load models
                            </Button>
                          </div>
                          {modelError && <p className="mt-1 text-xs text-danger">{modelError}</p>}
                          {getRecommendedModels(provider).length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-muted">Recommended:</span>
                              {getRecommendedModels(provider).map((m) => (
                                <Button
                                  key={m}
                                  size="sm"
                                  variant={model === m ? "primary" : "tertiary"}
                                  onPress={() => setModel(m)}
                                >
                                  {m}
                                </Button>
                              ))}
                            </div>
                          )}
                          {models.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {models.slice(0, 12).map((m) => (
                                <Button
                                  key={m}
                                  size="sm"
                                  variant={model === m ? "primary" : "tertiary"}
                                  onPress={() => setModel(m)}
                                >
                                  {m}
                                  {getRecommendedModels(provider).includes(m) && (
                                    <span className="ml-1 text-[10px] font-medium text-accent">Recommended</span>
                                  )}
                                </Button>
                              ))}
                            </div>
                          )}
                          <div>
                            <p className="mb-1 text-xs font-medium text-muted">API key</p>
                            <div className="relative">
                              <Input
                                aria-label="API key"
                                type={showKey ? "text" : "password"}
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="sk-..."
                                fullWidth
                                variant="secondary"
                                className="pr-11"
                              />
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={showKey ? "Hide" : "Show"}
                                onPress={() => setShowKey((s) => !s)}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2"
                              >
                                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                              </Button>
                            </div>
                            {apiKeyError && <p className="mt-1 text-xs text-danger">{apiKeyError}</p>}
                            {getAdapter(provider)?.apiKeyUrl && (
                              <button
                                type="button"
                                onClick={() => void browser.tabs.create({ url: getAdapter(provider)!.apiKeyUrl! })}
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                              >
                                Get a {getAdapter(provider)!.label} API key <ExternalLink className="size-3" />
                              </button>
                            )}
                            <p className="mt-1 text-[11px] text-muted">
                              Stored per provider locally only. Never synced.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {!showCustomForm ? (
                <Button size="sm" variant="tertiary" onPress={() => setShowCustomForm(true)}>
                  Add custom provider
                </Button>
              ) : (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-secondary/30 p-3">
                  <p className="text-sm font-medium">Add custom provider</p>
                  <Input
                    aria-label="Provider label"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    placeholder="e.g. Ollama Local"
                    fullWidth
                    variant="secondary"
                  />
                  <Input
                    aria-label="Custom base URL"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="https://.../v1 or http://localhost:11434/v1"
                    fullWidth
                    variant="secondary"
                  />
                  <Input
                    aria-label="Default model"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="e.g. llama3"
                    fullWidth
                    variant="secondary"
                  />
                  <Input
                    aria-label="API key URL"
                    value={customApiKeyUrl}
                    onChange={(e) => setCustomApiKeyUrl(e.target.value)}
                    placeholder="API key URL (optional)"
                    fullWidth
                    variant="secondary"
                  />
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted">Extra headers (optional)</p>
                    <TextArea
                      aria-label="Extra headers"
                      value={customHeadersText}
                      onChange={(e) => setCustomHeadersText(e.target.value)}
                      placeholder={"X-Custom-Header: value\nAnother: value"}
                      className="min-h-16 w-full resize-y"
                      variant="secondary"
                    />
                    <p className="mt-1 text-[11px] text-muted">One per line, `Header: value`.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onPress={() => void handleAddCustomProvider()}>
                      Add provider
                    </Button>
                    <Button size="sm" variant="ghost" onPress={() => setShowCustomForm(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {hint && <p className="text-xs text-danger">{hint}</p>}
            </div>
          )}

          <div style={{ display: step === 2 ? undefined : "none" }}>
            <TeachJotSection
              ref={teachJotRef}
              active={step === 2}
              autoPreview
              apiKeyFlush={{ provider, apiKey, apiKeyError }}
            />
          </div>

          {step === totalSteps - 1 && (
            <div className="flex flex-col gap-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success">
                <Check className="size-5" />
              </div>
              <div>
                <h2 className="font-jot text-base font-semibold">You’re all set</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Jot is ready. Your provider and prompts are saved. Select any text or focus an editable field, then
                  press the shortcut. Or practice end-to-end on the Wurkflo playground.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-secondary/60 p-4">
                <Kbd>Ctrl</Kbd>
                <span className="text-xs text-muted">+</span>
                <Kbd>Shift</Kbd>
                <span className="text-xs text-muted">+</span>
                <Kbd>Space</Kbd>
                <span className="mx-2 text-xs text-muted">or</span>
                <Kbd>⌘</Kbd>
                <span className="text-xs text-muted">+</span>
                <Kbd>Shift</Kbd>
                <span className="text-xs text-muted">+</span>
                <Kbd>Space</Kbd>
              </div>
              <p className="text-[11px] text-muted">
                Tip: change the shortcut at{" "}
                <button
                  type="button"
                  onClick={() => void browser.tabs.create({ url: "chrome://extensions/shortcuts" })}
                  className="font-medium text-accent hover:underline"
                >
                  chrome://extensions/shortcuts
                </button>
                .
              </p>
              <div className="rounded-xl border border-success/20 bg-success-soft/30 p-3 text-xs">
                <p className="font-medium text-success-soft-foreground">Quick recap</p>
                <ul className="mt-1 list-disc pl-5 text-muted">
                  <li>Provider: {getAdapter(provider)?.label ?? provider}</li>
                  <li>Shortcut: Ctrl/Cmd + Shift + Space</li>
                </ul>
              </div>
            </div>
          )}
        </Card>

        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="ghost" onPress={back} isDisabled={step === 0}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {step < totalSteps - 1 ? (
              <Button variant="primary" onPress={() => void next()} isPending={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {step === 0 ? "Get started" : step === 2 ? "Save & continue" : "Continue"}
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <>
                <Button variant="secondary" onPress={() => void browser.runtime.openOptionsPage()}>
                  Open settings
                </Button>
                <Button variant="primary" onPress={() => void finishOnboarding()}>
                  Open playground <ExternalLink className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void finishOnboarding()}
            disabled={!isProviderReady}
            aria-disabled={!isProviderReady}
            title={!isProviderReady ? "Connect a provider to continue" : undefined}
            className={`text-xs ${!isProviderReady ? "cursor-not-allowed text-muted/40" : "text-muted hover:text-foreground hover:underline"}`}
          >
            Skip for now
          </button>
          <span className="text-xs text-muted">·</span>
          <Chip size="sm" variant="soft" color="default">
            {step + 1} / {totalSteps}
          </Chip>
        </div>
      </div>
    </main>
  );
}
