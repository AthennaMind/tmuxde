# Paste image into terminal

Created 2026-10-11.

## Goal

Pasting an image into the terminal runs the Photo flow: upload to the relay upload directory, then insert the quoted path at the prompt. No protocol change. Uses existing `file:upload` with `ack`.

## Behavior

- Clipboard with an image file and no text: upload it. Text wins when both exist, so a spreadsheet or document copy still pastes as text.
- Capture-phase `paste` listener on the terminal container. xterm never sees an image paste, so it cannot send an empty bracketed paste.
- When upload is impossible (no write access, disconnected, no session, copy mode), show the reason as an alert and paste nothing.
- Photo button and paste share upload state, so the button reads `Uploading…` during a paste upload.

## Files

- `apps/web/src/lib/photo-upload.js`: `clipboardImage()`, pure and tested.
- `apps/web/src/lib/photo-insert.ts`: shared flow, upload blocker, pending store. Moved out of `PhotoUpload`.
- `apps/web/src/components/terminal/photo-upload.tsx`: uses shared flow.
- `apps/web/src/components/terminal/terminal-view.tsx`: paste listener.
- `apps/web/src/components/keyboard-shortcuts-dialog.tsx`: list the shortcut.
