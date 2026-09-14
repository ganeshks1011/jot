import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeId } from "../theme";

interface ThemePickerProps {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
  size?: "sm" | "md";
}

/**
 * Shared light/system/dark picker. Same radiogroup on the extension
 * options page and the website nav — one markup, one behavior.
 */
export function ThemePicker({ value, onChange, size = "sm" }: ThemePickerProps) {
  const entries = [
    ["light", Sun, "Light"],
    ["system", Monitor, "System"],
    ["dark", Moon, "Dark"],
  ] as const;
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center rounded-full bg-surface-secondary/60 p-0.5"
    >
      {entries.map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={`inline-flex items-center justify-center rounded-full transition ${
            size === "sm" ? "p-1.5" : "p-2"
          } ${value === id ? "bg-accent text-accent-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
