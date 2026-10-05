/**
 * Storage seams. The extension implements these with chrome.storage;
 * the web implements them with localStorage (+ Firestore where a user
 * exists). Components depend only on these interfaces — never on
 * chrome.* or localStorage directly.
 */

import type { SliderLevels } from "@wurkflo/shared";
import type { ThemeId } from "./theme";

export interface ThemeRepo {
  load(): Promise<ThemeId>;
  save(theme: ThemeId): Promise<void>;
  subscribe(cb: (theme: ThemeId) => void): () => void;
}

export interface RedactionRepo {
  load(): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}

export interface StyleLevelsRepo {
  load(): Promise<SliderLevels | null>;
  save(levels: SliderLevels): Promise<void>;
}

export interface JotSettingsRepo extends ThemeRepo {
  redaction: RedactionRepo;
  styleLevels: StyleLevelsRepo;
}
