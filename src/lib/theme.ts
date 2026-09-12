import { browser } from "wxt/browser";
import type { ThemeId } from "./types";

function resolveTheme(theme: ThemeId): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ThemeId): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
}

// Legacy name. Keep for compat.
export function applySystemTheme(): void {
  applyTheme("system");
}

export function watchTheme(): () => void {
  let current: ThemeId = "system";
  let mediaCleanup: (() => void) | null = null;

  const apply = (t: ThemeId) => {
    current = t;
    applyTheme(t);
    if (t === "system") {
      if (!mediaCleanup) {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => applyTheme("system");
        mq.addEventListener("change", onChange);
        mediaCleanup = () => mq.removeEventListener("change", onChange);
      }
    } else {
      if (mediaCleanup) {
        mediaCleanup();
        mediaCleanup = null;
      }
    }
  };

  // Initial load
  void (async () => {
    try {
      const stored = await browser.storage.sync.get("jot:theme");
      const raw = (stored["jot:theme"] as string | undefined) ?? "system";
      const theme: ThemeId = raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
      apply(theme);
    } catch {
      apply("system");
    }
  })();

  const storageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "sync" || !("jot:theme" in changes)) return;
    const raw = changes["jot:theme"].newValue as string | undefined;
    const theme: ThemeId = raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
    // Dedup. Already correct?
    if (theme === current) {
      // Still need to re-apply if system and mq changed? But mq watcher handles that.
      return;
    }
    apply(theme);
  };
  browser.storage.onChanged.addListener(storageListener);

  return () => {
    browser.storage.onChanged.removeListener(storageListener);
    if (mediaCleanup) {
      mediaCleanup();
      mediaCleanup = null;
    }
  };
}

export function watchSystemTheme(): () => void {
  return watchTheme();
}
