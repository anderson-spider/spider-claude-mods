---
name: review-publish
description: "Write the confirmed findings of a code-review report to a JSON file, or post them as a pending GitHub review or GitLab draft notes on the PR/MR. Use when the user wants review findings saved to a file, or says \"posta no PR\", \"comenta na MR\" or asks to post the review."
---

# Review publish

Turns the **CONFIRMED** findings of an `antigravity:code-review` report into a JSON file and,
when asked, into comments on the PR/MR. The input is the report already in this
conversation; with none, run the `antigravity:code-review` skill first, passing on the
user's request (fixed point, non-interactive mode). The report header gives the
fixed point, the diff command and whether uncommitted work was left out.

**Non-interactive mode** follows the review's: on when the request says so
("sem perguntas", "roda direto", "no questions"). Its defaults are stated in
place and go in the final report.

## The script

Run it as `node <this skill's folder>/scripts/findings.mjs`, from the repo root.
It needs Node 18 or later and nothing else. Below, `findings.mjs` stands for this
full command; `findings.mjs --help` prints every subcommand and its arguments.

## 1. Write the findings file

The findings file is the output path the request names, never a file the
review read. With no path named, step 2 writes it
to a new file under `mktemp -d`; a request to save the findings without a path
asks for one (_non-interactive:_ `mktemp -d` as well). Overwrite it with a JSON array of the
CONFIRMED findings, one object each, following `findings.mjs schema` (fields,
types, allowed values and an example).

- `side` is `new` for an added or context line, `old` for a removed line. The pair must fall inside a hunk of the reviewed diff in its default 3-line context (the hunks a PR shows): `new` lines on the `+` side of the hunk header, `old` lines among the removed lines. For a renamed file, `path` is the new path for `new` and the old path for `old`.
- Check every line with `findings.mjs check <fixed-point> <file>`; it prints `ok` or `FAIL` with the reason per finding. A confirmed finding with no line that passes stays out of the file; list it in the final report.
- `severity` matches the confirmed impact found in verification: the reviewer's label is a proposal you may lower or raise. `raisedBy` names the reviewer of the report's reviewer line: `["Gemini"]`, or `["Claude"]` when the fallback ran.
- `body` is the comment a colleague would leave on the PR line: direct and specific, in pt-BR unless the request names another language. Pass every `body` through the `humanizer` skill (installed separately) before writing, keeping code, identifiers and paths unchanged.
- With nothing confirmed, write `[]`.

The file is done when `findings.mjs check` prints `ok` for every finding in it.

## 2. Post to the PR/MR (only when the user asks)

Findings land as a **pending GitHub review** or **GitLab draft notes**: visible
only to the user, who edits, drops and submits them. Submitting stays with the
user, so the GitHub payload carries no `event` and drafts are never published.
The script builds every comment from the step 1 file.

1. **Match the diff.** With no open PR/MR for the reviewed branch, report the findings in the chat only and offer to open one. Otherwise the PR/MR is open, its head SHA equals local `HEAD`, and the review's fixed point is `origin/<its base branch>`. On GitHub, read its head SHA and base branch with the `github:github` skill (Pending reviews); on GitLab, with `mcp__plugin_gitlab_gitlab__gitlab_mr` `status` (`sha` and the target branch), as the `gitlab:gitlab` skill describes. When any differs, report which and post nothing: line numbers from another diff land on the wrong code.
2. **Find earlier drafts** with the same skill: on GitLab, `mcp__plugin_gitlab_gitlab__gitlab_mr_comment` `drafts`. When drafts exist, ask the user: on GitHub, which holds one pending review per user, submit it first or let this review replace it; on GitLab, add to the drafts or let these replace them (the gitlab tools cannot delete a draft: the `gitlab:gitlab` skill names the fallback). Replacing deletes the user's drafts, so it takes their explicit ok. _Non-interactive:_ GitHub posts nothing and reports the pending review; GitLab adds to the existing drafts.
3. **Post** as pending review or drafts.
   - GitHub: `findings.mjs github <fixed-point> <file> --commit <headRefOid> --body="<summary>"` prints the payload the `github:github` skill posts.
   - GitLab: `findings.mjs gitlab <fixed-point> <file> --iid <iid>` (add `--host <host>` and `--project <path-or-id>` when the `gitlab:gitlab` skill says the call needs them) prints a JSON array with one `mcp__plugin_gitlab_gitlab__gitlab_mr_comment` input per finding: a `line` draft note (`action`, `draft: true`, `iid`, `path`, `line` and/or `oldLine`, `body`). Call the tool once with each element as it is; the tool builds the diff position from the MR's diff refs. Then post the summary below as one more draft note: `action: "comment"`, `draft: true`, the same `iid`, `body`. On someone else's MR the tool refuses a comment write: add `allowOthers: true` to every call only when the user asked to post on that MR.

   The summary comment is the review's one-line summary plus each confirmed finding that has no diff line, written like a step 1 `body` (language, `humanizer`).

## Report

Give the findings file path; when step 2 ran, the PR/MR link and how many
comments were posted. List every confirmed finding the script left out, with
its reason.
