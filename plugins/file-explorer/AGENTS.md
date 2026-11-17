# file-explorer

## Invariants

- Observation never changes what the host answered: every observing hook returns `next(e)`'s result unchanged and ends in `.catch((_$, e, next) => next(e))`.
- Only finished, successful tool calls mark a file; refused or failed ones leave nothing.
- No model calls and no context: no `$.model`, no session append, no `prompt.submit`; `@path` goes in with `$.prompt.fill` and no file is read.
- Commands run by argv, never through a shell. Editor templates fill placeholders as whole arguments, and a template that hands its words to a shell or another machine is refused, since a file name would be read as code. The default opener refuses files it would run.
- Git runs with `--no-optional-locks` and `core.fsmonitor=false`, and `diff`/`show` add `--no-ext-diff --no-textconv`. A commit is detected from the command's `commit` verb, never a text pattern.
- One `git status` 300 ms after the last change, never two at once.
- Only the root and expanded folders are listed, capped per listing and per tree, and only the rows in view are drawn; `tests/performance.test.ts` holds the budgets.
- Links are opened only when expanded and never followed by the search walk.
- Timers end at `session.end`, except on `clear` or `resume`, after which no `session.start` comes.
- Nerd Font icons draw only on `terminal`; other surfaces use their own font.
- The cursor row uses a soft background, not inverse colours, so a shimmer on it still reads; tests read the cursor from the footer's `selected:` line.

## Checks

`tests/host.ts` is the host fake: an in-memory file system where `dir/` is a folder and `name -> target` a link, and a scripted git.
