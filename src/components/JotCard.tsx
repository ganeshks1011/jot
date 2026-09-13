import type { CSSProperties, ReactNode } from "react";

interface JotCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Composer pairing vars (--jot-cfg/--jot-cbg/--jot-shadow). Null = theme fallback. */
  pairedStyle?: CSSProperties;
  label?: string;
}

/**
 * The shared Jot card chrome: gradient border + page-aware shadow.
 * Same class on the extension overlay and the web landing panels.
 */
export function JotCard({ children, className = "", style, pairedStyle, label }: JotCardProps) {
  return (
    <div
      role={label ? "region" : undefined}
      aria-label={label}
      style={pairedStyle ? { ...style, ...pairedStyle } : style}
      className={`jot-card-glow rounded-xl bg-white dark:bg-gray-900 ${pairedStyle ? "jot-paired" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
