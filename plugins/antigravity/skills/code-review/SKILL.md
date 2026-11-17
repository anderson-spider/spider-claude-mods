---
name: code-review
description: "Review the commits since a fixed point (branch, tag or commit) with Gemini through this plugin's mcp__plugin_antigravity_antigravity__review tool, then verify every finding against the code before reporting. Use when the user wants to review a branch or a PR/MR, asks to \"review since X\", or before opening a PR/MR."
---

# Code review

Gemini reviews the diff between `HEAD` and a fixed point; you **verify** every finding against the code and report the verdicts. The reviewer comes from another model family than the author, so it does not share the author's assumptions; verification filters the false positives an outsider brings.

Run this in the main agent: the review tool is this plugin's `mcp__plugin_antigravity_antigravity__review` (load it with ToolSearch when it is deferred).

**Non-interactive mode** runs the whole review on stated defaults. It is on when the request says so ("sem perguntas", "roda direto", "no questions"). Each step states its non-interactive default in place of the question; every default you take goes in the report header, so none is silent. A bad ref or an empty diff still ends the review with an error.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a branch, tag, commit SHA, `main`, `HEAD~5`). If they didn't specify one, ask for it. A request to review only the last commit has the fixed point `HEAD~1`.

_Non-interactive, no fixed point given:_ run `git fetch --prune`, then take the first that resolves: `origin/HEAD`; `origin/<name>` with the name from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; `origin/main`. When none resolves, stop with an error naming the three you tried.

The diff command is `git diff <fixed-point>...HEAD` (three-dot: against the merge-base); note the commits with `git log <fixed-point>..HEAD --oneline`. Confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty before going further.

The review covers **commits only**. When `git status --short` shows changes, say in the report header that uncommitted and untracked work was left out.

### 2. Find the focus

The reviewer takes one extra sentence, `focus`. Look for what the change was meant to do: issue references in the commit messages or branch (`#123`, `Closes #45`, GitLab `!67`), fetched with the `github:github` or `gitlab:gitlab` skill, or a spec the user named. Write its intent as one sentence. With none, send no `focus`.

### 3. Run the reviewer

Call `mcp__plugin_antigravity_antigravity__review` with:

- `base`: the fixed point.
- `model`: `gemini-4-hydrogen-high`. Send no `effort`: the id carries it.
- `focus`: the sentence from step 2, when there is one.

A review that outlasts the foreground wait becomes a background job and a message arrives when it ends; wait for it. Read the full review from the Markdown file the result names: the inline text is an excerpt.

**Fallback.** When the tool is missing or the result is a failure (quota exhausted, timed out, agy error, local error, lost), run the review on a fresh native subagent instead: the `Agent` tool with `model: "opus"` and `effort: "medium"`. A run the user interrupted is not a failure: stop. The subagent's brief carries the repo's absolute path, the diff command, the commit list, the focus, a rule to change nothing, and this format:

> Report only real problems, most severe first, each as `[P0|P1|P2|P3] short title — path:line`, then one or two sentences on what goes wrong and when. P0 breaks the build, loses data or opens a security hole; P1 is a bug users hit; P2 a bug in an edge case or a missing check at a real boundary; P3 a minor correctness or clarity issue worth fixing. Leave out style, naming and formatting comments. If you find nothing, say "No findings."

The fallback reviewer shares the author's family, so the report says so.

### 4. Verify every finding

For each finding, open the cited code and the diff and give it one verdict:

- **CONFIRMED**: the defect is real and introduced by the diff.
- **REJECTED**: the code disproves it (quote the line that does) or it is pre-existing.
- **UNVERIFIED**: you can't settle it without running something or asking the user.

You share the author's family, so the verdict rests on evidence from the code, never on agreement with the author's intent. Every finding ends with a verdict.

Give each confirmed finding a severity from the impact you verified, starting from the reviewer's label: P0 → `blocker`, P1 → `major`, P2 → `minor`, P3 → `nit`.

### 5. Report

Open with the reviewer line, then the fixed point, the diff command and whether uncommitted work was left out. In non-interactive mode, follow it with every default you took.

- Gemini ran: `Reviewer: Gemini · gemini-4-hydrogen-high`.
- Fallback ran: `Reviewer: Claude · opus, medium (fallback: <the failure>; same family as the author)`.

List the findings most severe first, each with its severity, `path:line`, the claim and its verdict; a REJECTED finding carries the one-line reason. End with a one-line summary: how many findings were confirmed and the worst of them. To save the confirmed findings to a file or post them on the PR/MR, use the `antigravity:review-publish` skill.
