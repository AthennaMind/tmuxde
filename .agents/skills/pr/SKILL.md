---
name: pr
description: Check the current branch for an existing PR and either update or create one with an auto-generated description based on all commits since diverging from main.
---

Create or update a GitHub Pull Request for the current branch.

## Steps

1. **Gather branch info.** Run these commands in parallel:
   - `git branch --show-current` to get the current branch name.
   - `git merge-base main HEAD` to find where this branch diverged from main.
   - `git status` to check for uncommitted changes (never use `-uall`).

2. **Handle `main` branch.** If the current branch is `main`:
   - Look at the recent commits on main that are not yet in a PR (use `git log origin/main..HEAD` to find unpushed commits, or if there are none, ask the user how many recent commits to include).
   - Derive a branch name from the commit messages. Use the pattern `feat/<short-slug>`, `fix/<short-slug>`, or `chore/<short-slug>` depending on the nature of the changes. The slug should be lowercase, hyphen-separated, and max 4 words (e.g., `feat/markdown-preview`, `fix/pane-switch-copy-mode`).
   - Ask the user to confirm the branch name before creating it.
   - Create the branch: `git checkout -b <branch-name>`.
   - Continue with the rest of the steps using this new branch.

3. **Handle uncommitted changes.** If there are staged or unstaged changes (modified/added/deleted files):
   - Run `git diff` and `git diff --cached` to understand what changed.
   - Stage the relevant files with `git add` (prefer adding specific files over `git add -A`; never commit `.env`, credentials, or secrets).
   - Write a commit message that accurately describes the changes. Use a short imperative subject line and include a description body if the changes are non-trivial. 
   - Commit the changes before proceeding.
   - If the changes are unclear and you cannot write a good commit message, ask the user what these changes are for.

4. **Collect commit history.** Using the merge base from step 1, run in parallel:
   - `git log <merge-base>..HEAD --format="### %s%n%n%b%n---"` to get all commit subjects AND bodies on this branch. Both the subject line and the description body are important for understanding changes.
   - `git diff <merge-base>...HEAD --stat` to get the file-level diff summary.
   - `git diff <merge-base>...HEAD --name-only` to get the list of changed files.

5. **Check for existing PR.** Run `gh pr view --json number,title,url,state` to see if a PR already exists for this branch.

6. **Analyze changes.** Review ALL commits (not just the latest) and the diff stat to understand the full scope. Categorize changes into backend and frontend sections where applicable.

7. **Generate PR description.** Write a concise, accurate description following this format:

   ```
   ## What this does

   <2-4 plain-language sentences a non-engineer can read. Explain what the change
   does for the user or the product and why it matters. No jargon, no file names,
   no class or function names - describe behavior, not implementation.>

   ## Summary

   - <1-3 bullet points covering the main changes across ALL commits>

   ```

   Rules for the description:
   - The "What this does" section always comes first and stays plain-language;
     anyone reading only that section should understand the point of the PR.
   - The summary should cover ALL commits on the branch, not just the latest.
   - Test plan items should be concrete and testable.
   - Never use emojis.

8. **Create or update the PR:**
   - **If a PR exists:** Update its body using `gh pr edit <number> --body "<body>"`. Keep the existing title unless it is clearly wrong or does not match the `[TYPE] Area: summary` convention below.
   - **If no PR exists:** Push the branch with `git push -u origin <branch>` if needed, then create the PR using `gh pr create --title "<title>" --body "<body>"`. The title follows the repo convention `[TYPE] Area: summary`, where TYPE is `FEAT`, `FIX`, or `CHORE` (upper case, in brackets) and Area is the main domain touched (for example `Terminal`, `Sessions`, `Files`, `Changes`, `History`, `Dictation`, `Relay`, `Docker`, `Docs`). The summary is lowercase after the colon, in imperative or plain noun style, and reflects the overall theme of the branch. Keep it short, ideally under 80 chars. Check `gh pr list --state all --limit 20` if unsure about area names. Do not use conventional-commit prefixes like `fix(scope):` in PR titles.
   - Always pass the body via a HEREDOC for correct formatting.

9. **Report back.** Print the PR URL so the user can open it.
