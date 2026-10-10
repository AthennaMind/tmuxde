# Mobile usability implementation plan

Goal: Deliver all five improvements approved by user from latest phone screenshot.

1. Remove floating tmux trigger from terminal. Keep action sheet mounted and open it from More > Tmux actions. Preserve existing pane and window actions.
2. Hide mobile window tabs while html[data-keyboard=open], restoring them on close. Desktop stays visible.
3. Add manual navigation mode under More. Compact navigation row contains keyboard toggle, four repeating arrows, Esc, Enter, and More. Mode switch dismisses keyboard. Typing mode preserves current Photo first row. Repeat stops on release, cancel, pointer leave, blur, hidden page, disconnect, session change, mode change, or unmount. Never focus input for navigation commands.
4. Lift dim terminal text on mobile while preserving colors and ANSI meaning. Inspect installed xterm renderer, use scoped change, verify dim and normal text across theme changes.
5. Add post-upload thumbnail and recent photos with explicit reuse. Keep Photo directly opening picker. Add Recent photos under More and desktop near Photo. Scope history to current connection, bound retained entries, use authenticated preview fetch, handle missing files, and never send Enter. Reuse validates current session and pane before insertion.

Validation: targeted unit tests for new behavior, browser checks for mobile space, navigation tap/hold/cancellation, photo preview and reuse, existing typing/upload regressions. Build and deploy web, verify healthy stack. Review new delta. Existing unrelated working-tree edits stay intact.
