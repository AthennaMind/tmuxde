import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A fixed-length digit entry.
 *
 * One real input behind a row of dots rather than N inputs: N inputs fight the
 * software keyboard, break paste, and get the backspace-into-the-previous-box
 * behaviour wrong on at least one mobile browser. This is `inputMode="numeric"`
 * with `autoComplete="off"`, and the dots are presentation.
 */
export function PinPad({
  length,
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  label,
}: {
  length: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const completed = useRef(false);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (value.length === length && !completed.current) {
      completed.current = true;
      onComplete?.(value);
    }
    if (value.length < length) completed.current = false;
  }, [value, length, onComplete]);

  return (
    <div className="relative">
      <label className="sr-only" htmlFor="tmuxde-pin">
        {label}
      </label>
      <input
        id="tmuxde-pin"
        ref={inputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        // A PIN typed into a field a password manager offers to save is a PIN
        // stored next to the data it protects.
        data-1p-ignore
        maxLength={length}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        className="absolute inset-0 h-full w-full cursor-default opacity-0"
        aria-describedby="tmuxde-pin-dots"
      />
      <div
        id="tmuxde-pin-dots"
        className="pointer-events-none flex items-center justify-center gap-3 py-4"
        aria-hidden
      >
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border transition-colors",
              i < value.length
                ? "border-primary bg-primary"
                : "border-border bg-transparent",
            )}
          />
        ))}
      </div>
    </div>
  );
}
