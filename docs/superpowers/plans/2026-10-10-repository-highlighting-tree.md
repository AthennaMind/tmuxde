# Repository highlighting and change tree

Goal: Add local syntax highlighting and optional folder hierarchy to current-change viewer.

Design: Keep existing mobile controls and semantic colors. Highlight source and diff content without changing text or loading remote resources. Unknown languages retain plain text. Changes retain separate staged, unstaged and untracked groups. Add List and Tree buttons with saved preference. Folders expand and collapse; file taps open existing diff preview.

Implementation:
- Extract change rendering into repository-changes.tsx. Build sorted folder hierarchy with unit tests for nested and unusual paths.
- Add bounded local highlighting helper and line component, with multiline and diff tests. Use bundled grammars, no CDN.
- Integrate both components into repository-browser.tsx.
- Verify unit tests, typecheck and mobile/desktop browser behavior. Build and deploy only local web service.

Validation: source tokens preserve original text, multiline constructs work, diff markers remain visible, tree folders collapse, preview uses correct scope, preference survives reopening, uploads and keyboard controls remain intact.
