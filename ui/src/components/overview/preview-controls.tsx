import { useEffect, useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { configurePreviews } from "@/stores/terminal-preview-store";

const SIZES = [
  { value: "16rem", label: "Small" },
  { value: "20rem", label: "Medium" },
  { value: "32rem", label: "Large" },
];

export function PreviewControls({
  size,
  setSize,
}: {
  size: string;
  setSize: (size: string) => void;
}) {
  const sizeId = useId();
  useEffect(() => {
    configurePreviews({ open: true, hidden: document.hidden });
    return () => configurePreviews({ open: false, hidden: document.hidden });
  }, []);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <label htmlFor={sizeId}>Preview size</label>
      <Select value={size} onValueChange={setSize}>
        <SelectTrigger id={sizeId} className="w-28 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {SIZES.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
