/**
 * Extension ThemeRepo: chrome.storage.sync behind the jot-ui seam.
 * Lets overlay/options components consume useTheme/ThemePicker without
 * importing storage directly.
 */

import type { ThemeId, ThemeRepo } from "@wurkflo/jot-ui";
import { getTheme, saveTheme, watchTheme } from "./storage";

export const chromeThemeRepo: ThemeRepo = {
  load(): Promise<ThemeId> {
    return getTheme();
  },
  save(theme: ThemeId): Promise<void> {
    return saveTheme(theme);
  },
  subscribe(cb: (theme: ThemeId) => void): () => void {
    return watchTheme(cb);
  },
};
