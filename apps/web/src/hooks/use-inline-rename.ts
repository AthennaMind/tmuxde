"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The state behind "click Rename, type, press Enter".
 *
 * ## Why a hook
 *
 * Two components implemented this independently — the session card and the
 * management row — with the same five pieces of state and two different bugs.
 * Both dropped focus on the floor when the field closed: the rename is entered
 * from a Radix dropdown item, and Radix returns focus to its trigger only when
 * *it* closes the menu. By the time the input unmounts the menu is long gone,
 * so focus fell to `<body>` and a keyboard user was back at the top of the
 * document. `returnFocusRef` is the fix, and it has to be threaded through the
 * component, which is why it is returned rather than managed internally.
 *
 * The other difference worth naming: a refused rename used to be a four-second
 * toast while the input sat open saying nothing. The message belongs under the
 * control that produced it, so `error` is state here rather than a side effect
 * somewhere else.
 */
export type RenameResult = { ok: true } | { ok: false; message: string | null };

export type InlineRename = {
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  saving: boolean;
  /** Set when the rename was refused with something worth reading. */
  error: string | null;
  start: () => void;
  cancel: () => void;
  submit: () => Promise<void>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Point this at the control the rename was launched from. */
  returnFocusRef: React.RefObject<HTMLElement | null>;
};

export function useInlineRename({
  name,
  onRename,
}: {
  /** The current name, which seeds the draft each time editing opens. */
  name: string;
  onRename: (next: string) => Promise<RenameResult>;
}): InlineRename {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const start = useCallback(() => {
    setDraft(name);
    setError(null);
    setEditing(true);
  }, [name]);

  /**
   * Close, and put focus back where it came from.
   *
   * A `requestAnimationFrame` rather than a bare call: the input is still
   * mounted at this point, and focusing the trigger before React has swapped
   * the subtree lets the dying input take focus back with it.
   */
  const close = useCallback(() => {
    setEditing(false);
    setError(null);
    const target = returnFocusRef.current;
    if (target) requestAnimationFrame(() => target.focus());
  }, []);

  const submit = useCallback(async () => {
    const next = draft.trim();
    if (!next || next === name) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onRename(next);
    setSaving(false);
    if (result.ok) {
      close();
      return;
    }
    // A refusal keeps the field open with what they typed, so the rename
    // survives reading whatever the refusal had to say. `message: null` means
    // something else on screen — the upgrade dialog — is already saying it.
    setError(result.message);
  }, [close, draft, name, onRename]);

  return {
    editing,
    draft,
    setDraft,
    saving,
    error,
    start,
    cancel: close,
    submit,
    inputRef,
    returnFocusRef,
  };
}
