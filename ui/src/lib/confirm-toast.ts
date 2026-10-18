import { toast } from "sonner";

interface ConfirmActionOptions {
  title: string;
  description?: string;
  onConfirm: () => void;
  destructive?: boolean;
}

export function confirmAction({
  title,
  description,
  onConfirm,
  destructive,
}: ConfirmActionOptions) {
  toast(title, {
    description,
    duration: Infinity,
    action: {
      label: destructive ? "Kill" : "Confirm",
      onClick: onConfirm,
    },
    cancel: {
      label: "Cancel",
      onClick: () => {},
    },
    classNames: destructive
      ? { actionButton: "!bg-destructive !text-destructive-foreground" }
      : undefined,
  });
}
