import * as React from "react";
import { cn } from "../lib/utils";
import { Button, type ButtonProps } from "./ui/button";

function triggerHaptic(duration = 10) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(duration);
  }
}

interface HapticButtonProps extends ButtonProps {
  hapticDuration?: number;
}

const HapticButton = React.forwardRef<HTMLButtonElement, HapticButtonProps>(
  ({ className, hapticDuration = 10, onClick, ...props }, ref) => {
    const handleClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        triggerHaptic(hapticDuration);
        onClick?.(e);
      },
      [hapticDuration, onClick],
    );

    return (
      <Button
        ref={ref}
        className={cn("min-h-[44px] min-w-[44px]", className)}
        onClick={handleClick}
        {...props}
      />
    );
  },
);
HapticButton.displayName = "HapticButton";

export { HapticButton, triggerHaptic };
