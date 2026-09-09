"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { SegmentedControl } from "@repo/ui/components/segmented-control";
import { Switch } from "@repo/ui/components/ui/switch";
import { CopyCommand } from "./copy-command";
import { buildShareCommand, type ShareFiles } from "./share-command";

/**
 * Builds the `mtmux share` command, and does nothing else.
 *
 * The browser deliberately cannot mint a grant. Minting one needs the tmux
 * truth about which sessions exist and what their ids are (only the relay has
 * that) and a broker socket to arm a pairing code (only the CLI process has
 * that, and in split mode there is no agent at all). A dashboard button that
 * appeared to create a share would have to round-trip through a machine that
 * may well be offline, and would fail in a way that looks like a bug.
 *
 * So this is a command builder. It is honest about what it is, and the copy
 * button is the whole feature.
 */

const EXPIRY_OPTIONS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "never", label: "Never" },
] as const;

type Expiry = (typeof EXPIRY_OPTIONS)[number]["value"];

const FILE_OPTIONS: { value: ShareFiles; label: string }[] = [
  { value: "none", label: "No files" },
  { value: "ro", label: "Read files" },
  { value: "rw", label: "Read + write files" },
];

const DEFAULT_EXPIRY: Expiry = "7d";

export function ShareDialog({
  open,
  onOpenChange,
  serverName,
  session = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  /** Prefilled once the cross-server session list knows the name. */
  session?: string;
}) {
  const [name, setName] = useState(session);
  const [readOnly, setReadOnly] = useState(false);
  const [files, setFiles] = useState<ShareFiles>("none");
  const [expires, setExpires] = useState<Expiry>(DEFAULT_EXPIRY);

  /*
   * A render-phase reset, and the reason it has to exist.
   *
   * This dialog is permanently mounted — `open` is a prop, so the component
   * renders whether or not it is on screen — and `useState(session)` therefore
   * captured the *first* value of `session`, which on a freshly mounted
   * dashboard is `""`. It never took another one. So opening Share on a session
   * called `deploy-prod` and pressing Copy put `mtmux share ` on the clipboard,
   * with a trailing space and no session, on every share anyone has ever made
   * from this page.
   *
   * `readOnly`, `files` and `expires` are reset for a smaller version of the
   * same problem: they persisted across opens, so a read-write share configured
   * once quietly became the default for every later one, including for a
   * different machine.
   *
   * This is React's documented way to reset state when a prop changes — an
   * effect would paint the stale command for a frame first, and a `key` alone
   * cannot help a caller that renders the dialog unconditionally. The callers
   * pass a `key` as well, so a remount is the belt to this braces.
   */
  const [seed, setSeed] = useState(session);
  if (seed !== session) {
    setSeed(session);
    setName(session);
    setReadOnly(false);
    setFiles("none");
    setExpires(DEFAULT_EXPIRY);
  }

  const command = buildShareCommand({
    session: name,
    readOnly,
    files,
    expires,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a session on {serverName}</DialogTitle>
          <DialogDescription>
            Run this on {serverName}. It prints a pairing code the other person
            enters at app.mtmux.com — they never get your machine, only what you
            name here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="share-session">tmux session</Label>
            <Input
              id="share-session"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="work"
              autoComplete="off"
              spellCheck={false}
              className="h-11 font-mono"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="share-read-only">Read-only</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                They can watch, and cannot type.
              </p>
            </div>
            <Switch
              id="share-read-only"
              checked={readOnly}
              onCheckedChange={setReadOnly}
            />
          </div>

          {/*
            One choice, not three toggles.

            These were bare `<button aria-pressed>`, which is what you reach for
            when the group is only ever clicked — but it announces three
            unrelated toggle buttons, makes each one a separate tab stop, and
            gives arrow keys nothing to do. `SegmentedControl` is the APG
            radiogroup: one tab stop, arrows between the segments.
          */}
          <div className="space-y-2">
            <Label id="share-files-label">Files</Label>
            <SegmentedControl
              labelledBy="share-files-label"
              value={files}
              onChange={setFiles}
              options={FILE_OPTIONS}
            />
          </div>

          <div className="space-y-2">
            <Label id="share-expires-label">Expires</Label>
            <SegmentedControl
              labelledBy="share-expires-label"
              value={expires}
              onChange={setExpires}
              options={EXPIRY_OPTIONS}
            />
          </div>

          <CopyCommand command={command} />

          {/*
            The same paragraph the CLI prints before the code, for the same
            reason: read-write is a scope on the client, not a boundary on the
            machine. Saying it only in the terminal would mean the person
            configuring the share from a phone never reads it.
          */}
          {readOnly ? (
            <p className="text-sm text-muted-foreground">
              Read-only is a real boundary — the viewer attaches to a locked
              copy of the session that accepts no input at all.
            </p>
          ) : (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              Read-write means they are typing into a shell on this machine.
              mtmux keeps them in this session, but the shell does not — they
              can run <code className="font-mono">tmux switch-client</code>,
              read <code className="font-mono">~/.ssh</code>, or anything your
              user account can do. Turn on read-only for a share that is
              actually a boundary.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
