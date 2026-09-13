import { Slider } from "@heroui/react/slider";
import type { SliderDimension, SliderLevel, SliderLevels } from "@wurkflo/shared";
import { sliderLevelToLabel } from "@wurkflo/shared";

interface StyleSlidersProps {
  levels: SliderLevels;
  disabled?: boolean;
  onChange: (dimension: SliderDimension, level: SliderLevel) => void;
  onCommit: (dimension: SliderDimension, level: SliderLevel) => void;
}

const SLIDERS = [
  ["casual", "Casual ↔ Professional"],
  ["direct", "Direct ↔ Gentle"],
  ["length", "Short ↔ Detailed"],
] as const;

/**
 * Shared style sliders: the same three 1–5 controls on the extension
 * Teach-Jot section and the website personalization demo. Visual state
 * lifts to the host; persistence arrives via StyleLevelsRepo.
 */
export function StyleSliders({ levels, disabled = false, onChange, onCommit }: StyleSlidersProps) {
  return (
    <div className="flex flex-col gap-3">
      {SLIDERS.map(([dim, label]) => (
        <Slider
          key={dim}
          minValue={1}
          maxValue={5}
          step={1}
          value={[levels[dim]]}
          onChange={(v: number | number[]) => {
            const val = Array.isArray(v) ? v[0] : v;
            onChange(dim, val as SliderLevel);
          }}
          onChangeEnd={(v: number | number[]) => {
            const val = Array.isArray(v) ? v[0] : v;
            onCommit(dim, val as SliderLevel);
          }}
          isDisabled={disabled}
          aria-label={label}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">{label}</span>
            <span className="text-[11px] font-medium">{sliderLevelToLabel(dim, levels[dim])}</span>
          </div>
          <Slider.Track className="mt-1">
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      ))}
    </div>
  );
}
