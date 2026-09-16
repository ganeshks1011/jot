import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
import { Spinner } from "@heroui/react/spinner";
import { RefreshCw } from "lucide-react";

interface FeedbackInputProps {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  disabled: boolean;
  /** True while a rewrite is in flight; the submit button shows a spinner. */
  pending?: boolean;
  /** State-dependent hint: idle invites input, output invites refinement. */
  placeholder?: string;
}

/** Compact tweak box: short input plus a labeled Tweak button. */
export function FeedbackInput({
  value,
  onChange,
  onEnter,
  disabled,
  pending = false,
  placeholder = "Tell Jot what to change...",
}: FeedbackInputProps) {
  const canSubmit = !disabled && !!value.trim();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        id="jot-feedback"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onEnter();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        fullWidth
        variant="secondary"
        className="h-8 min-w-0 flex-1"
        disabled={disabled}
      />
      <Button
        size="sm"
        variant={canSubmit && !pending ? "primary" : "tertiary"}
        aria-label="Tweak"
        className="shrink-0"
        isDisabled={disabled || (!value.trim() && !pending)}
        isPending={pending}
        onPress={() => {
          if (!disabled) onEnter();
        }}
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            Tweak
          </>
        )}
      </Button>
    </div>
  );
}
