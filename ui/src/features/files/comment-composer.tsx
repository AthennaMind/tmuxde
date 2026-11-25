import { sendCommentPrompt } from "./send-comment-prompt";
import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useComments, empty } from "./comment-store";
import { CommentContext, type AgentComment, type CommentImage } from "./comment-context";
import { CornerDownLeft, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { get } from "@/features/connection/relay-registry";
import { machineId } from "@/features/connection/machine-context";
import { useConnectionStore } from "@/features/connection/connection-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useSessionStore } from "@/features/session/session-store";
import { canUploadPhotos } from "@/features/photos/photo-insert";
import {
  clipboardImage,
  preparePhoto,
  uploadPhoto,
  photoPathText,
  photoUploadPath,
} from "@/features/photos/photo-upload-client";
import { CommentImagePreview } from "./comment-image-preview";
import { isShell } from "@/shared/shell-commands";

const uploaded = new WeakSet<CommentImage>();

function imageReference(path: string) {
  return "Image: " + photoPathText(path).trim();
}

function formatComment(c: AgentComment) {
  const location = c.diff
    ? `${c.path} (${c.diff.scope}, ${c.diff.location})\n${c.diff.text}`
    : c.range
      ? `${c.path}:${c.range.startLineNumber}-${c.range.endLineNumber}`
      : c.path;
  return [
    location,
    c.snippet,
    c.note.trim(),
    ...c.images.map((image) => imageReference(image.path)),
  ]
    .filter(Boolean)
    .join("\n");
}

interface ComposerProps {
  machine: string;
  children?: React.ReactNode;
  onSend?: () => void;
  workspaceReview?: boolean;
}
export function CommentComposer(props: ComposerProps) {
  const session = useSessionStore((s) => s.activeSessionId);
  const key = JSON.stringify([props.machine, session]);
  return <ScopedComposer key={key} {...props} session={session} batchKey={key} />;
}
function ScopedComposer({
  machine,
  children,
  onSend,
  workspaceReview,
  session,
  batchKey: key,
}: ComposerProps & { session: string | null; batchKey: string }) {
  const [sending, setSending] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const comments = useComments((s) => s.batches[key] ?? empty);
  const previousPrompt = useComments((s) => s.lastPrompt[key]);
  const panes = usePaneStore((s) => s.panes);
  const connected = useConnectionStore(
    (s) => s.status === "connected" && !s.capabilities?.readOnly,
  );
  const candidates = panes.filter((p) => p.command && !isShell(p.command));
  const [target, setTarget] = useState("");
  const targetKey = (p: (typeof panes)[number]) => JSON.stringify([p.id, p.command]);
  const pane = target
    ? candidates.find((p) => targetKey(p) === target)
    : candidates.length === 1 && /^(codex|claude)$/.test(candidates[0]?.command ?? "")
      ? candidates[0]
      : undefined;
  const [draft, setDraft] = useState<AgentComment | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [review, setReview] = useState(false);

  const uploadVersion = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  useEffect(
    () => () => {
      uploadVersion.current++;
    },
    [machine, session],
  );

  async function pasteImage(event: React.ClipboardEvent) {
    const file = clipboardImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    if (uploading) return;
    const client = get(machine);
    const connection = useConnectionStore.getState();
    if (
      machineId() !== machine ||
      client?.status !== "connected" ||
      !canUploadPhotos(connection) ||
      !connection.defaultPath
    ) {
      setUploadError("Connect to a machine with photo uploads enabled.");
      return;
    }
    const version = ++uploadVersion.current;
    setUploadError("");
    setUploading(true);
    try {
      const photo = await preparePhoto(file);
      if (version !== uploadVersion.current) return;
      const id = crypto.randomUUID();
      const saved = {
        file: photo,
        directory: connection.defaultPath,
        id,
        path: photoUploadPath(photo, connection.defaultPath, id),
      };
      if (version !== uploadVersion.current) return;
      setDraft((current) => current && { ...current, images: [...current.images, saved] });
      setPreview((current) =>
        current === null ? null : current + "\n" + imageReference(saved.path),
      );
    } catch (error) {
      if (version === uploadVersion.current)
        setUploadError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      if (version === uploadVersion.current) setUploading(false);
    }
  }

  const openComment = useCallback((comment: AgentComment) => {
    uploadVersion.current++;
    setUploading(false);
    setUploadError("");
    setDeliveryError("");
    setDraft(comment);
    setPreview(null);
    setReview(false);
  }, []);
  const context = useMemo(() => ({ comments, open: openComment }), [comments, openComment]);
  const editing = !!draft && comments.some((c) => c.id === draft.id);
  const hasComment = !!draft && (!!draft.note.trim() || draft.images.length > 0);
  const next = editing
    ? comments.map((c) => (c.id === draft?.id ? draft : c))
    : hasComment
      ? [...comments, draft]
      : comments;
  const prompt = preview ?? next.map(formatComment).join("\n\n");
  const canSend =
    !sending &&
    (!editing || hasComment) &&
    !uploading &&
    !!pane &&
    connected &&
    !!session &&
    machine === machineId() &&
    !!prompt.trim() &&
    prompt.length <= 32768;
  function store(entries: AgentComment[]) {
    useComments.setState((s) => ({ batches: { ...s.batches, [key]: entries } }));
  }
  function jump(c: AgentComment) {
    const paneId = c.paneId ?? activePaneId;
    if (!paneId) return;
    const r = c.range;
    const source = c.diff?.source;
    useMainTabsStore.getState().openFile({
      machineId: machine,
      sessionName: session,
      paneId,
      path: source?.relativePath ?? c.path,
      ...(source && {
        scope: source.scope,
        root: source.root,
        contextPath: source.root,
        commentJump: { id: c.id, requestId: crypto.randomUUID() },
      }),
      ...(r && {
        position: {
          commentId: c.id,
          line: r.startLineNumber,
          endLine: r.endLineNumber,
          column: r.startColumn,
          endColumn: r.endColumn,
          requestId: crypto.randomUUID(),
        },
      }),
    });
    setBatchOpen(false);
  }
  async function send(submit: boolean) {
    const client = get(machine);
    if (!canSend || !pane?.command || client?.status !== "connected") return;
    setDeliveryError("");
    setSending(true);
    const version = uploadVersion.current;
    let disconnected = false;
    const offStatus = client.onStatusChange((status) => {
      if (status !== "connected") disconnected = true;
    });
    try {
      const stillActive = () =>
        !disconnected &&
        version === uploadVersion.current &&
        machineId() === machine &&
        useSessionStore.getState().activeSessionId === session &&
        get(machine) === client &&
        client.status === "connected";
      for (const image of next.flatMap((comment) => comment.images)) {
        if (!prompt.includes(photoPathText(image.path).trim()) || uploaded.has(image)) continue;
        if (!stillActive()) throw new Error("Workspace changed. Send the batch again.");
        await uploadPhoto(client, image.file, image.directory, image.id);
        uploaded.add(image);
      }
      if (!stillActive()) throw new Error("Workspace changed. Send the batch again.");
      await sendCommentPrompt(client, pane.id, pane.command, prompt, submit);
    } catch (error) {
      setDeliveryError(error instanceof Error ? error.message : "Paste failed");
      return;
    } finally {
      offStatus();
      setSending(false);
    }
    if (version !== uploadVersion.current) return;
    useComments.setState((s) => ({
      batches: {
        ...s.batches,
        [key]: (s.batches[key] ?? empty).filter((c) => !comments.includes(c)),
      },
      lastPrompt: { ...s.lastPrompt, [key]: prompt },
    }));
    setBatchOpen(false);
    onSend?.();
    setDraft(null);
  }
  return (
    <>
      <CommentContext.Provider value={context}>{children}</CommentContext.Provider>
      {workspaceReview && comments.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="sticky right-0 ms-auto shrink-0 self-center rounded-full bg-background"
          onClick={() => {
            setPreview(null);
            setDeliveryError("");
            setBatchOpen(true);
          }}
          aria-label={`Review batch, ${comments.length} comments`}
        >
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </Button>
      )}
      <Dialog
        open={!!draft || (batchOpen && comments.length > 0)}
        onOpenChange={(open) => {
          if (!open && !sending) {
            setBatchOpen(false);
            uploadVersion.current++;
            setDraft(null);
          }
        }}
      >
        {(draft || batchOpen) && (
          <DialogContent
            onPaste={draft ? pasteImage : undefined}
            inert={sending}
            aria-busy={sending}
            aria-describedby={undefined}
            className="max-h-[90dvh] overflow-y-auto w-[calc(100%-1.5rem)] max-w-sm gap-3 rounded-2xl p-4 shadow-xl sm:rounded-2xl"
          >
            <DialogTitle className="pr-7 text-base">
              {draft ? (editing ? "Edit agent comment" : "Agent comment") : "Review batch"}
            </DialogTitle>
            {draft ? (
              <>
                <div
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={draft.path}
                >
                  {draft.path.split("/").pop()}
                  {draft.diff && ` · ${draft.diff.scope} · ${draft.diff.location}`}
                  {draft.range && `:${draft.range.startLineNumber}-${draft.range.endLineNumber}`}
                </div>
                {draft.diff && (
                  <code className="max-h-16 overflow-auto whitespace-pre-wrap text-xs">
                    {draft.diff.text}
                  </code>
                )}
                <textarea
                  aria-label="Comment"
                  placeholder="Describe a change or paste an image"
                  rows={2}
                  className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm"
                  value={draft.note}
                  onChange={(e) => {
                    setDraft({ ...draft, note: e.target.value });
                    setPreview(null);
                  }}
                />
                {draft.images.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {draft.images.map((img, i) => (
                      <div key={img.id} className="relative">
                        <CommentImagePreview file={img.file} className="size-14 rounded-lg" />
                        <button
                          type="button"
                          aria-label={`Remove image ${i + 1}`}
                          className="absolute right-0 top-0 rounded-full border bg-background p-1"
                          onClick={() => {
                            setDraft({
                              ...draft,
                              images: draft.images.filter((image) => image !== img),
                            });
                            setPreview(
                              (current) => current?.replace(imageReference(img.path), "") ?? null,
                            );
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {uploading && (
                  <p role="status" className="text-xs text-muted-foreground">
                    Preparing image…
                  </p>
                )}
                {uploadError && (
                  <p role="alert" className="text-xs text-destructive">
                    {uploadError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!hasComment || uploading}
                    onClick={() => {
                      store(next);
                      setDraft(null);
                    }}
                  >
                    {editing ? (
                      "Save changes"
                    ) : (
                      <>
                        <Plus size={14} /> Add to batch
                      </>
                    )}
                  </Button>
                  {editing && (
                    <button
                      className="text-xs text-destructive underline"
                      onClick={() => {
                        if (comments.length === 1) setBatchOpen(false);
                        store(comments.filter((c) => c.id !== draft.id));
                        setDraft(null);
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <button
                    className="text-xs underline underline-offset-2"
                    disabled={!next.length && !previousPrompt && !preview}
                    onClick={() => {
                      if (!next.length && !preview) setPreview(previousPrompt ?? null);
                      setReview(!review);
                    }}
                  >
                    {review
                      ? "Hide prompt"
                      : next.length
                        ? `Review prompt (${next.length})`
                        : previousPrompt
                          ? "Last prompt"
                          : "Review prompt"}
                  </button>
                </div>
                {review && (
                  <div className="grid gap-1">
                    {comments.length > 0 && (
                      <ul className="max-h-24 overflow-y-auto">
                        {comments.map((c) => (
                          <li key={c.id}>
                            <button
                              className="block w-full truncate text-left text-xs underline"
                              onClick={() => openComment(c)}
                            >
                              Edit {c.path.split("/").pop()}
                              {c.diff
                                ? ` · ${c.diff.location}`
                                : c.range
                                  ? `:${c.range.startLineNumber}`
                                  : ""}{" "}
                              · {c.note || "Image comment"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <textarea
                      aria-label="Prompt"
                      className="max-h-48 rounded-lg border bg-muted p-2 text-xs"
                      rows={5}
                      value={prompt}
                      onChange={(e) => setPreview(e.target.value)}
                    />
                    {comments.length > 0 && (
                      <button
                        className="justify-self-end text-xs underline"
                        onClick={() => {
                          setBatchOpen(false);
                          store(empty);
                          setDraft(null);
                        }}
                      >
                        Clear batch
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <ul className="grid gap-2">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-lg border p-2">
                      <button
                        type="button"
                        className="break-all text-left font-mono text-xs underline"
                        disabled={!(c.paneId ?? activePaneId) || (!!c.diff && !c.diff.source)}
                        onClick={() => jump(c)}
                      >
                        {c.path}
                        {c.diff
                          ? ` · ${c.diff.scope} · ${c.diff.location}`
                          : c.range
                            ? `:${c.range.startLineNumber}-${c.range.endLineNumber}`
                            : ""}
                      </button>
                      {(c.diff?.text || c.snippet) && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">Original selection</summary>
                          <pre className="max-h-24 overflow-auto whitespace-pre-wrap">
                            {c.diff?.text ?? c.snippet}
                          </pre>
                        </details>
                      )}
                      {c.note && (
                        <p className="whitespace-pre-wrap break-words text-sm">{c.note}</p>
                      )}
                      {!!c.images.length && (
                        <div className="flex flex-wrap gap-1">
                          {c.images.map((img) => (
                            <CommentImagePreview key={img.id} file={img.file} className="size-12" />
                          ))}
                        </div>
                      )}
                      <div className="flex gap-3 text-xs">
                        <button onClick={() => openComment(c)}>Edit</button>
                        <button
                          className="text-destructive"
                          onClick={() => {
                            store(comments.filter((n) => n.id !== c.id));
                            setPreview(null);
                            if (comments.length === 1) setBatchOpen(false);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <details>
                  <summary className="cursor-pointer text-sm">Review prompt</summary>
                  <textarea
                    aria-label="Batch prompt"
                    rows={5}
                    className="mt-1 w-full rounded-lg border bg-background p-2 text-sm"
                    value={prompt}
                    onChange={(e) => setPreview(e.target.value)}
                  />
                </details>
              </>
            )}
            <select
              aria-label="Destination pane"
              className="w-full truncate rounded-lg border bg-background px-2 py-1.5 text-sm"
              value={pane ? targetKey(pane) : ""}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">
                {candidates.length ? "Choose destination pane" : "No agent pane in current window"}
              </option>
              {candidates.map((p) => (
                <option key={p.id} value={targetKey(p)}>
                  {p.command} · {p.id} · {p.path}
                </option>
              ))}
            </select>
            {deliveryError && (
              <p role="alert" className="text-sm text-destructive">
                {deliveryError}
              </p>
            )}
            {prompt.length > 32768 && <p role="alert">Shorten prompt to 32768 characters.</p>}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="rounded-lg"
                disabled={!canSend}
                onClick={() => send(false)}
              >
                Paste only
              </Button>
              <Button
                size="sm"
                className="rounded-lg"
                disabled={!canSend}
                onClick={() => send(true)}
              >
                Paste and Enter <CornerDownLeft size={14} />
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
