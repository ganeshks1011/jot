import { useCallback, useEffect, useState } from "react";
import type { ThemeRepo } from "./repos";
import { isThemeId, type ResolvedTheme, type ThemeId } from "./theme";

/**
 * Theme state bound to an injected repo. Applies data-theme/.dark to the
 * document root and follows prefers-color-scheme while set to "system".
 * SSR-safe: resolves to light until mounted.
 */
export function useTheme(repo: ThemeRepo): {
  theme: ThemeId;
  resolved: ResolvedTheme;
  setTheme: (t: ThemeId) => void;
} {
  const [theme, setThemeState] = useState<ThemeId>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    let alive = true;
    let mediaCleanup: (() => void) | null = null;

    const apply = (t: ThemeId) => {
      if (!alive) return;
      const raw = isThemeId(t) ? t : "system";
      setThemeState(raw);
      if (typeof document === "undefined") return;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const next: ResolvedTheme = raw === "system" ? (mq.matches ? "dark" : "light") : raw;
      document.documentElement.dataset.theme = next;
      document.documentElement.classList.toggle("dark", next === "dark");
      setResolved(next);
      if (raw === "system" && !mediaCleanup && typeof mq.addEventListener === "function") {
        const onChange = () => {
          if (!alive) return;
          const sys: ResolvedTheme = mq.matches ? "dark" : "light";
          document.documentElement.dataset.theme = sys;
          document.documentElement.classList.toggle("dark", sys === "dark");
          setResolved(sys);
        };
        mq.addEventListener("change", onChange);
        mediaCleanup = () => mq.removeEventListener("change", onChange);
      }
      if (raw !== "system" && mediaCleanup) {
        mediaCleanup();
        mediaCleanup = null;
      }
    };

    void repo
      .load()
      .then(apply)
      .catch(() => apply("system"));
    const unsub = repo.subscribe(apply);
    return () => {
      alive = false;
      unsub();
      if (mediaCleanup) mediaCleanup();
    };
  }, [repo]);

  const setTheme = useCallback(
    (t: ThemeId) => {
      setThemeState(t);
      void repo.save(t).catch(() => undefined);
    },
    [repo],
  );

  return { theme, resolved, setTheme };
}
