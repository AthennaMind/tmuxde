import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { FileEntry } from "@/protocol";
import { cn } from "@/shared/utils";
import { RepositoryFileIcon } from "./repository-file-icon";

export function FileNameInput({
  initialName = "",
  type,
  depth,
  onSubmit,
  onCancel,
  onPendingChange,
}: {
  initialName?: string;
  type: FileEntry["type"];
  depth: number;
  onSubmit: (name: string, signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      const dot = initialName.lastIndexOf(".");
      input.current?.setSelectionRange(
        0,
        type !== "directory" && dot > 0 ? dot : initialName.length,
      );
      input.current?.scrollIntoView({ block: "nearest" });
    });
    return () => {
      cancelAnimationFrame(frame);
      request.current?.abort();
    };
  }, [initialName, type]);

  const submit = async () => {
    if (request.current) return;
    if (name === initialName && initialName) {
      onCancel();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      await onSubmit(name, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError((cause as Error).message);
        input.current?.focus();
      }
    } finally {
      request.current = null;
      onPendingChange(false);
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <div
      className="py-px pe-1 text-[13px]"
      style={{ paddingInlineStart: 24 + depth * 14 }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        } else if (event.key === "Escape" && !pending) {
          event.preventDefault();
          onCancel();
        }
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="flex h-7 items-center gap-1.5">
        <RepositoryFileIcon path={name} type={type} className="h-3.5 w-3.5 shrink-0" />
        <input
          ref={input}
          data-file-name-input
          aria-label={`${initialName ? "Rename" : "New"} ${type === "directory" ? "folder" : "file"} name`}
          aria-invalid={!!error}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-busy={pending}
          autoComplete="off"
          spellCheck={false}
          value={name}
          readOnly={pending}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          className={cn(
            "h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-foreground outline-none",
            error && "border-destructive",
          )}
        />
        {pending && <LoaderCircle aria-label="Saving name" className="h-3.5 w-3.5 animate-spin" />}
      </div>
      <span id={`${id}-hint`} className="sr-only">
        Enter to confirm. Escape to cancel.
      </span>
      {error && (
        <p id={`${id}-error`} role="alert" className="ps-5 text-xs text-destructive break-words">
          {error}
        </p>
      )}
    </div>
  );
}
