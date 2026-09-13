/**
 * Framework-free theme primitives. Persistence stays in the host app
 * (chrome.storage.sync in the extension, localStorage on the web) and
 * arrives here via ThemeRepo — this module only resolves and applies.
 */

export type ThemeId = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function isThemeId(raw: unknown): raw is ThemeId {
  return raw === "light" || raw === "dark" || raw === "system";
}

export function resolveTheme(theme: ThemeId, prefersDark: boolean): ResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark ? "dark" : "light";
}

/** Apply the resolved theme to a document root (data-theme + .dark). */
export function applyThemeTo(
  root: { dataset: { theme?: string }; classList: { toggle: (c: string, f?: boolean) => void } },
  theme: ThemeId,
  prefersDark: boolean,
): ResolvedTheme {
  const resolved = resolveTheme(theme, prefersDark);
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function prefersDarkTheme(matchMediaFn: (query: string) => { matches: boolean }): boolean {
  try {
    return matchMediaFn("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}
