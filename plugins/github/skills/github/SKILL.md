---
name: github
description: GitHub work (pull requests, Actions runs, workflow logs, reviews, issues, comments) done by the main agent with the gh CLI. Use automatically whenever the user pastes a github.com URL or mentions a PR, pull request, Actions run, workflow failure, "abre o PR" or "vê o run", even without saying GitHub. Never for GitLab.
---

# GitHub

Do this yourself in the main agent; do not delegate to a subagent.

## Tools

- Use `gh` for everything; pass `-R owner/repo` (from the URL) when not inside a clone. Never use it for GitLab.
- Use git and the code to understand what happened (failing run, PR diff, branch state); edit files only when the task requires a fix.
- Never force-push, merge, close or delete anything unless the user explicitly asked.

## Creating a pull request

- Title and description in English; title in Conventional Commits: `type(scope): description`.
- Always `gh pr create --assignee @me` (ready, never `--draft`).
- The repo's own rules (CLAUDE.md/AGENTS.md, CONTRIBUTING, PR templates, commit-lint) win over these defaults.

## Review comments

Write review comments in the language the user writes to you in, and run them through the `humanizer` skill before posting when it is installed.

## Pending reviews

A review created without `event` stays PENDING: only its author sees it, edits it and submits it. A user holds one pending review per PR.

- Read the PR: `gh pr view --json number,url,headRefOid,baseRefName`.
- Find pending reviews: `gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews --jq '.[] | select(.state=="PENDING") | .id'`.
- Create one from a JSON payload with `commit_id`, `body` and `comments` (`path`, `line`, `side`, `body`) and no `event`: `gh api repos/{owner}/{repo}/pulls/<n>/reviews --input -`.
- Delete one only when the user explicitly said to replace it: `gh api -X DELETE repos/{owner}/{repo}/pulls/<n>/reviews/<id>`.

## Runs and workflows

- Never wait: no `--watch`, polling loops or `sleep`. Check status once and report it as it is (queued, running, passed, failed).
- For workflow logs, show the relevant raw excerpts (errors, failing step, last lines) plus your diagnosis.
