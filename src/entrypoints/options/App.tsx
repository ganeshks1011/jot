import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
import { Switch } from "@heroui/react/switch";
import { Tabs } from "@heroui/react/tabs";
import { TextArea } from "@heroui/react/textarea";
import { ThemePicker } from "@wurkflo/jot-ui";
import { Check, ExternalLink, Eye, EyeOff, Loader2, LogIn, LogOut, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import TeachJotSection from "@/components/TeachJotSection";
import { useWurkfloLink } from "@/hooks/useWurkfloLink";
import { track } from "@/lib/analytics";
import { listModels } from "@/lib/api";
import { completeWurkfloLink, extensionAuthUrl, signOutWurkflo, watchWurkfloAuth } from "@/lib/auth";
import { headersToText, validateCustomProvider } from "@/lib/customProvider";
import {
  getAdapter,
  getAllAdapters,
  getRecommendedModels,
  isBuiltin,
  isLocalProvider,
  OPENAI_ENDPOINT_PRESETS,
  ProviderError,
} from "@/lib/providers";
import { isRetiredModel } from "@/lib/providers/openai";
import { validateApiKey } from "@/lib/providerValidation";
import {
  clearPendingLinkCode,
  DEFAULT_BACKEND,
  getAnalyticsEnabled,
  getApiKey,
  getBackendConfig,
  getCustomProviders,
  getPendingLinkCode,
  getRedactionEnabled,
  getRedactNamesEnabled,
  getTheme,
  getWurkfloRemaining,
  getWurkfloUser,
  removeCustomProvider,
  saveAnalyticsEnabled,
  saveApiKey,
  saveBackendConfig,
  saveRedactionEnabled,
  saveRedactNamesEnabled,
  saveTheme,
  upsertCustomProvider,
  type WurkfloUserSnapshot,
  watchPendingLinkCode,
  watchTheme,
  watchWurkfloUser,
} from "@/lib/storage";
import type { CustomProviderMeta, ProviderId, ThemeId } from "@/lib/types";

export default function App() {
  // Extension page view (options). Fires once on mount.
  useEffect(() => {
    void track("page_view", {
      page_title: document.title,
      page_location: location.href,
    });
  }, []);

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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [wurkfloUser, setWurkfloUser] = useState<WurkfloUserSnapshot | null>(null);
  const [wurkfloRemaining, setWurkfloRemainingState] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const baselineRef = useRef<string>("");
  const [providerOptions, setProviderOptions] = useState(() => getAllAdapters());
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customApiKeyUrl, setCustomApiKeyUrl] = useState("");
  const [customHeadersText, setCustomHeadersText] = useState("");
  const [customMetas, setCustomMetas] = useState<CustomProviderMeta[]>([]);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    const metas = await getCustomProviders();
    setCustomMetas(metas);
    setProviderOptions(getAllAdapters());
  }, []);

  // Validate API key per provider and auto-save debounced (so Load models sees latest)
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

  const [redactEnabled, setRedactEnabled] = useState(true);

  useEffect(() => {
    void getRedactionEnabled().then(setRedactEnabled);
  }, []);

  const handleRedactionChange = useCallback((v: boolean) => {
    setRedactEnabled(v);
    void saveRedactionEnabled(v);
  }, []);

  const [redactNamesEnabled, setRedactNamesEnabled] = useState(false);

  useEffect(() => {
    void getRedactNamesEnabled().then(setRedactNamesEnabled);
  }, []);

  const handleRedactNamesChange = useCallback((v: boolean) => {
    setRedactNamesEnabled(v);
    void saveRedactNamesEnabled(v);
  }, []);

  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);

  useEffect(() => {
    void getAnalyticsEnabled().then(setAnalyticsEnabled);
  }, []);

  const handleAnalyticsChange = useCallback((v: boolean) => {
    setAnalyticsEnabled(v);
    void saveAnalyticsEnabled(v);
  }, []);

  // Wurkflo account: mirror snapshot + live updates while the page is open.
  useEffect(() => {
    void getWurkfloUser().then(setWurkfloUser);
    void getWurkfloRemaining().then(setWurkfloRemainingState);
    const unsubStorage = watchWurkfloUser(setWurkfloUser);
    const unsubAuth = watchWurkfloAuth();
    return () => {
      unsubStorage();
      unsubAuth();
    };
  }, []);

  const {
    linking,
    linkError,
    handleConnect: handleWurkfloConnect,
    handleSignOut: handleWurkfloSignOut,
  } = useWurkfloLink();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await getBackendConfig();
      const key = await getApiKey(cfg.provider);
      if (cancelled) return;
      setProvider(cfg.provider);
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setApiKey(key);
      const metas = await getCustomProviders();
      if (cancelled) return;
      setCustomMetas(metas);
      setProviderOptions(getAllAdapters());
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Unsaved-changes detection: compare a normalized snapshot of the form
  // against the last loaded/saved baseline. Mirrors exactly what save()
  // persists (trimmed values, empty site patterns dropped).
  const buildSnapshot = useCallback(
    () =>
      JSON.stringify({
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      }),
    [provider, baseUrl, model, apiKey],
  );

  useEffect(() => {
    if (!loaded) return;
    if (!baselineRef.current) baselineRef.current = buildSnapshot();
    setDirty(buildSnapshot() !== baselineRef.current);
  }, [loaded, buildSnapshot]);

  // Warn before the options tab closes or navigates away with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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

  const selectProvider = useCallback((id: ProviderId) => {
    const adapter = getAdapter(id);
    if (!adapter) return;
    setProvider(id);
    setBaseUrl(adapter.defaultBaseUrl);
    setModel(adapter.defaultModel);
    setModels([]);
    void getApiKey(id).then((k) => setApiKey(k));
  }, []);

  const resetCustomForm = useCallback(() => {
    setShowCustomForm(false);
    setEditingCustomId(null);
    setCustomLabel("");
    setCustomBaseUrl("");
    setCustomModel("");
    setCustomApiKeyUrl("");
    setCustomHeadersText("");
  }, []);

  const handleSaveCustomProvider = useCallback(async () => {
    const validated = validateCustomProvider(
      {
        label: customLabel,
        baseUrl: customBaseUrl,
        model: customModel,
        apiKeyUrl: customApiKeyUrl,
        headersText: customHeadersText,
      },
      editingCustomId ?? undefined,
    );
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
      resetCustomForm();
      setHint(null);
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Could not save provider");
    }
  }, [
    customLabel,
    customBaseUrl,
    customModel,
    customApiKeyUrl,
    customHeadersText,
    editingCustomId,
    refreshProviders,
    resetCustomForm,
  ]);

  const handleEditCustomProvider = useCallback(
    (id: string) => {
      const meta = customMetas.find((m) => m.id === id);
      if (!meta) return;
      setEditingCustomId(id);
      setCustomLabel(meta.label);
      setCustomBaseUrl(meta.baseUrl);
      setCustomModel(meta.defaultModel);
      setCustomApiKeyUrl(meta.apiKeyUrl ?? "");
      setCustomHeadersText(headersToText(meta.extraHeaders));
      setShowCustomForm(true);
      setHint(null);
    },
    [customMetas],
  );

  const handleRemoveCustomProvider = useCallback(
    async (id: string) => {
      const meta = customMetas.find((m) => m.id === id);
      if (!meta) return;
      if (!window.confirm(`Remove "${meta.label}"? Its stored API key will be deleted.`)) return;
      try {
        await removeCustomProvider(id);
        await refreshProviders();
        if (provider === id) {
          const fallback = getAdapter("jot-api")!;
          setProvider(fallback.id as ProviderId);
          setBaseUrl(fallback.defaultBaseUrl);
          setModel(fallback.defaultModel);
          setApiKey("");
          setModels([]);
        }
        if (editingCustomId === id) resetCustomForm();
        setHint(null);
      } catch (err) {
        setHint(err instanceof Error ? err.message : "Could not remove provider");
      }
    },
    [customMetas, editingCustomId, provider, refreshProviders, resetCustomForm],
  );

  const save = useCallback(async () => {
    if (isRetiredModel(model)) {
      setHint(modelError ?? "This model is retired. Use gemini-3.5-flash-lite");
      return;
    }
    setSaveState("saving");
    try {
      const adapter = getAdapter(provider);
      if (!adapter) throw new Error(`Unknown provider "${provider}"`);
      await saveBackendConfig({
        provider,
        baseUrl: baseUrl.trim() || adapter.defaultBaseUrl,
        model: model.trim() || adapter.defaultModel,
      });
      await saveApiKey(apiKey.trim(), provider);
      baselineRef.current = buildSnapshot();
      setDirty(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setHint("Could not save settings");
      setSaveState("idle");
    }
  }, [provider, baseUrl, model, apiKey, buildSnapshot]);

  return (
    <main className="flex min-h-screen items-start justify-center p-6">
      <div className="w-full max-w-2xl">
        <header className="mb-6 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <img src={browser.runtime.getURL("/icon/icon128.png")} alt="" className="size-9 rounded-xl" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Jot Settings</h1>
              <p className="text-xs text-muted">Model provider, API key, and writing modes.</p>
            </div>
          </div>
          <ThemePicker value={theme} onChange={handleThemeChange} />
        </header>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-surface">
          <Tabs defaultSelectedKey="provider">
            <Tabs.List aria-label="Settings sections">
              <Tabs.Tab id="provider">
                Provider &amp; API
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="modes">
                Teach Jot
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="settings">
                Settings
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel id="provider" className="flex flex-col gap-4 pt-4">
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
                      {!isBuiltin(a.id) && (
                        <div className="flex gap-2 pl-1">
                          <Button
                            size="sm"
                            variant="tertiary"
                            onPress={() => handleEditCustomProvider(a.id)}
                            aria-label={`Edit ${a.label}`}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onPress={() => void handleRemoveCustomProvider(a.id)}
                            aria-label={`Remove ${a.label}`}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                      {selected && a.id === "jot-api" && (
                        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-secondary/50 p-4">
                          {wurkfloUser ? (
                            <>
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">{wurkfloUser.email}</p>
                                  <p className="text-xs text-muted">
                                    {wurkfloRemaining === null
                                      ? "Signed in via Wurkflo"
                                      : `${wurkfloRemaining} of 100 free requests left this month`}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onPress={() => void handleWurkfloSignOut()}
                                  aria-label="Sign out of Wurkflo"
                                >
                                  <LogOut className="size-3.5" />
                                  Sign out
                                </Button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-sm font-medium">Connect Jot Rewrite API from Wurkflo</p>
                              <p className="text-xs text-muted">
                                100 free requests per month, no API key required. A Wurkflo tab will open for you to
                                sign in and approve the connection.
                              </p>
                              <Button size="sm" variant="primary" onPress={handleWurkfloConnect} className="self-start">
                                <LogIn className="size-3.5" />
                                Connect Jot Rewrite API from Wurkflo
                              </Button>
                              {linking && (
                                <p className="inline-flex items-center gap-1.5 text-xs text-muted">
                                  <Loader2 className="size-3 animate-spin" />
                                  Finish connecting in the Wurkflo tab...
                                </p>
                              )}
                              {linkError && (
                                <p className="text-xs text-danger" role="alert">
                                  {linkError}
                                </p>
                              )}
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
                            {isLocalProvider(provider, baseUrl) && (
                              <p className="mt-1 text-[11px] text-muted">
                                Local model, no API key needed — requests stay on this machine. Run{" "}
                                <code>ollama serve</code>, pull a model (<code>ollama pull qwen2.5</code>), then Load
                                models. If the browser blocks the connection, start Ollama with{" "}
                                <code>OLLAMA_ORIGINS=chrome-extension://*</code>.
                              </p>
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
                              aria-label="Load models"
                            >
                              <RefreshCw className="size-3.5" />
                              Load models
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
                              {models.slice(0, 24).map((m) => (
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
                                placeholder={
                                  isLocalProvider(provider, baseUrl) ? "Not needed for local models" : "sk-..."
                                }
                                fullWidth
                                variant="secondary"
                                className="pr-11"
                              />
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={showKey ? "Hide API key" : "Show API key"}
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
                                onClick={() =>
                                  void browser.tabs.create({
                                    url: getAdapter(provider)!.apiKeyUrl!,
                                  })
                                }
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                              >
                                Get a {getAdapter(provider)!.label} API key
                                <ExternalLink className="size-3" />
                              </button>
                            )}
                            <p className="mt-1.5 text-[11px] text-muted">
                              Stored per provider in chrome.storage.local on this device - never synced to your Google
                              account and never sent anywhere except the provider above.
                            </p>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-border pt-4">
                {!showCustomForm ? (
                  <Button size="sm" variant="tertiary" onPress={() => setShowCustomForm(true)}>
                    <Plus className="size-3.5" />
                    Add custom provider
                  </Button>
                ) : (
                  <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-secondary/30 p-3">
                    <p className="text-sm font-medium">
                      {editingCustomId ? "Edit custom provider" : "Add custom provider"}
                    </p>
                    <p className="text-xs text-muted">
                      Any OpenAI-compatible endpoint. Share via code with{" "}
                      <code className="rounded bg-surface px-1 py-0.5 text-[11px]">createOpenAIProvider</code> +{" "}
                      <code className="rounded bg-surface px-1 py-0.5 text-[11px]">registerProvider</code>.
                    </p>
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
                        className="min-h-16 w-full resize-y scrollbar-thin"
                        variant="secondary"
                      />
                      <p className="mt-1 text-[11px] text-muted">One per line, `Header: value`.</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onPress={() => void handleSaveCustomProvider()}>
                        {editingCustomId ? "Save changes" : "Add provider"}
                      </Button>
                      <Button size="sm" variant="ghost" onPress={() => resetCustomForm()}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Tabs.Panel>

            <Tabs.Panel id="modes" className="flex flex-col gap-4 pt-4">
              <TeachJotSection active autoPreview={false} apiKeyFlush={{ provider, apiKey, apiKeyError }} />
            </Tabs.Panel>

            <Tabs.Panel id="settings" className="flex flex-col gap-4 pt-4">
              <div>
                <p className="mb-1 text-sm font-medium text-muted">Keyboard shortcut</p>
                <p className="text-xs text-muted">
                  Jot opens with the browser-level shortcut: Ctrl/Cmd+Shift+Space. You can also click the Jot icon in
                  the toolbar.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-surface-secondary/50 p-4 text-sm">
                To change the shortcut, visit{" "}
                <button
                  type="button"
                  onClick={() => void browser.tabs.create({ url: "chrome://extensions/shortcuts" })}
                  className="font-medium text-accent hover:underline"
                >
                  chrome://extensions/shortcuts
                </button>
                .
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-secondary/50 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Protect sensitive information</p>
                  <p className="text-[11px] text-muted">
                    Detect and replace sensitive information on this device before text is sent to AI.
                  </p>
                </div>
                <Switch
                  isSelected={redactEnabled}
                  onChange={handleRedactionChange}
                  aria-label="Protect sensitive information"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-secondary/50 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Also redact person names</p>
                  <p className="text-[11px] text-muted">Local name detection, loaded on demand. Off by default.</p>
                </div>
                <Switch
                  isSelected={redactNamesEnabled}
                  onChange={handleRedactNamesChange}
                  aria-label="Also redact person names"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-secondary/50 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Share anonymous usage statistics</p>
                  <p className="text-[11px] text-muted">
                    Helps improve Jot. Counts usage only. Message content never leaves your device for analytics.
                  </p>
                </div>
                <Switch
                  isSelected={analyticsEnabled}
                  onChange={handleAnalyticsChange}
                  aria-label="Share anonymous usage statistics"
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </div>

              <p className="text-[11px] leading-relaxed text-muted">
                Jot activates only when you press the shortcut or click its toolbar icon. It has no standing access to
                websites - Chrome grants temporary access to the current tab at that moment, and it ends when you
                navigate away. Jot only accesses webpage content necessary to provide the writing functionality you
                explicitly request.
              </p>
            </Tabs.Panel>
          </Tabs>

          {hint && <p className="mt-4 text-xs text-danger">{hint}</p>}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-4">
            {dirty && saveState !== "saved" && (
              <p className="mr-auto text-[11px] font-medium text-muted" role="status">
                Unsaved changes - save before you leave.
              </p>
            )}
            <Button variant="primary" isPending={saveState === "saving"} onPress={() => void save()}>
              {({ isPending }) =>
                isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : saveState === "saved" ? (
                  <Check className="size-4" />
                ) : (
                  "Save"
                )
              }
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
