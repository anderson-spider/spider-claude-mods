# What the Codex CLI offers for reviewing a diff

Question (issue #369): does Codex CLI 0.166 have a non-interactive review entry point, which inputs does it take, does it honor the read-only sandbox, `--json`, `-o`, model and effort overrides and `exec resume`, and what does its output look like?

Sources: `codex exec review --help` and `codex review --help` of the installed `codex-cli 0.166.0`, a live run on a throwaway repository (below), and the openai/codex source on `main`:
[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs),
[`codex-rs/protocol/src/protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) (`ReviewTarget`, `ReviewOutputEvent`, `ReviewFinding`),
[`codex-rs/protocol/src/review_format.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/review_format.rs),
[`codex-rs/core/src/tasks/review.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/review.rs).

## Answer

Yes. `codex exec review` (and the alias-like top-level `codex review`) runs a review non-interactively. It accepts the same `--json`, `-o`, `-m`, `-c`, `--ephemeral` and `--output-schema` options as `codex exec`, and worked read-only with `--json` and `-o` in the live run. Its final message is plain text rendered from a structured review (title, priority, absolute path and line range per finding); the structured object itself is not emitted in the `exec --json` stream.

## Entry points

- `codex exec review [OPTIONS] [PROMPT]`: "Run a code review against the current repository". Full `exec` option set: `-m/--model`, `-c`, `--json`, `-o/--output-last-message`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `--worktree`, `--ignore-user-config`, `--dangerously-bypass-approvals-and-sandbox` (help output).
- `codex review [OPTIONS] [PROMPT]`: "Run a code review non-interactively", but with only `-c`, `--enable/--disable`, `--strict-config` and the target flags: no `--json`, `-o` or `-m`. The plugin should use `codex exec review`.

## Inputs (review target)

Exactly one target per run; clap marks them mutually exclusive (`conflicts_with_all` in `exec/src/cli.rs`):

| Flag | `ReviewTarget` variant |
| --- | --- |
| `--uncommitted` | `UncommittedChanges` (staged, unstaged and untracked) |
| `--base <BRANCH>` | `BaseBranch { branch }` |
| `--commit <SHA>` (+ optional `--title`) | `Commit { sha, title }` |
| `[PROMPT]` (or `-` for stdin) | `Custom { instructions }` |

The prompt **conflicts with** `--base`, `--commit` and `--uncommitted`: custom instructions are a separate target, not extra guidance added to a branch review. To get "review against main, focus on X" you either write the full request in the prompt (Codex then decides how to diff) or use `--base` without focus text. No `--base` with an explicit commit range beyond a branch name.

With `--base main`, Codex resolved the merge base itself and ran `git diff <merge-base-sha>` (live run, first command item).

## Options it honors (verified live unless marked)

- Read-only sandbox: `-c sandbox_mode="read-only" -c approval_policy="never"` worked; Codex only ran read commands (`git diff`, `cat`, `ls`).
- `--json`: yes, the usual JSONL events (`thread.started`, `turn.started`, `item.*` with `command_execution`, `reasoning`, `agent_message`, `turn.completed`).
- `-o <FILE>`: yes, gets the same text as the final `agent_message`.
- Effort: `-c model_reasoning_effort="low"` accepted. `-m` is listed in help (not exercised).
- stdin must be closed (`</dev/null`), as for `codex exec`; `PROMPT` `-` reads instructions from stdin.
- `exec resume`: `thread.started` gives a `thread_id`, and `codex exec resume [SESSION_ID] [PROMPT]` exists, so a follow-up question on a review thread looks possible; not tested live. Its help notes `--cyber-access-program` is "Not supported with review".
- `--output-schema`: listed, but the review task uses its own output contract; whether it applies to review was not tested.

## Output shape

Internally the reviewer returns a `ReviewOutputEvent` (`protocol.rs`):

```text
ReviewOutputEvent { findings: [ReviewFinding], overall_correctness, overall_explanation, overall_confidence_score }
ReviewFinding     { title, body, confidence_score, priority, code_location { absolute_file_path, line_range { start, end } } }
```

`render_review_output_text` (`review_format.rs`) turns it into text: the overall explanation, a blank line, then `Review comment:` (one finding) or `Full review comments:` (several), each as `- <title> — <absolute path>:<start>-<end>` with the body indented two spaces. The title carries the priority tag (`[P1]` etc.). With no explanation and no findings it prints `Reviewer failed to output a response.`

In `exec --json` that text arrives as one `agent_message` item; `overall_correctness` and the confidence scores do not appear. A consumer must parse the text (the format is stable code, not model prose) to get structured findings.

The text follows the user's Codex language preferences: in this machine's setup it came out in Portuguese. Usage in `turn.completed` was all zeros for this run.

## Captured sample

Throwaway repo, `main` with `div`, branch `feat` adding `avg` and a buggy `get` (`d[k+1]`):

```sh
codex exec review --base main --json -o /tmp/cxr/last.txt \
  -c sandbox_mode='"read-only"' -c approval_policy='"never"' \
  -c model_reasoning_effort='"low"' </dev/null
```

Exit code 0, 9 JSONL lines. Final `agent_message` / `-o` file:

```text
A nova função de acesso ao dicionário usa uma chave diferente da informada, produzindo resultados incorretos ou exceções.

Review comment:

- [P1] Acesse o dicionário pela chave informada — /private/tmp/cxr/repo/m.py:8-8
  Ao buscar uma chave, `get` usa `k + 1` em vez de `k`: com chaves numéricas, retorna outro valor ou lança `KeyError`; com chaves comuns, como strings, lança `TypeError`. Use a chave recebida diretamente para que a função retorne o valor solicitado.
```

Note the path is absolute and resolved (`/private/tmp`, not `/tmp`). The reviewer also read the user's Codex skills and memory files from `~/.codex` during the run; `--ignore-user-config` exists if that is unwanted.

## Alternative: the app-server `review/start`

Question: does `codex app-server` give a review something `codex exec review` does not, namely the structured `ReviewOutputEvent` or custom focus together with a branch target?

Sources: `codex app-server generate-json-schema` of `codex-cli 0.166.0`, and a live run over stdio JSON-RPC (`initialize`, `thread/start`, `review/start`) on a throwaway repository, read-only (`-c sandbox_mode="read-only" -c approval_policy="never"`).

Answer: no on both counts; it is the same review behind a heavier protocol.

- `review/start` takes `{ threadId, target, delivery? }`. `target` is the same four-way `ReviewTarget` (`uncommittedChanges`, `baseBranch { branch }`, `commit { sha, title? }`, `custom { instructions }`), one per call, so focus text still cannot ride along with `baseBranch`. `delivery` only accepts `inline`.
- The result is text. The turn ends with an `exitedReviewMode` item whose `review` is a string, followed by an `agentMessage` with the same text. The schema has no `ReviewOutputEvent`, `overall_correctness` or confidence fields, and `findings` do not appear as data. The live run returned the same rendered text as `exec review` (`[P1] title — /abs/path:2-2`, indented body).
- Extra cost: a long-lived process, the `initialize` handshake, thread management and notification handling, where `exec review` is one command with `--json` and `-o`.

Conclusion: keep `codex exec review`. The app-server adds no structured findings and no new target, so it is not worth replacing the CLI call.
