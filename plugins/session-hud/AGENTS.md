# session-hud

`hooks/steps.ts` adapts two MIT plugins: keep `hooks/LICENSE.next-steps.txt` and the README credit.

## Invariants

- Code Mode stays available: the module registers no event that turns it off; what the card needs from tool calls comes from the transcript.
- Subagents and teammates are not tracked: events with an `agentId` change nothing.
- Observation never changes host answers, and the band always draws what comes from `next(e)` under the card, so it never hides another plugin.
- On screen only: figures, Claude model names (else `?`), known efforts and workspace names. Never a prompt, an answer, a tool input, a whole path or money.
- The workspace is named, never shown as a path; names go through `clean` and are cut by code point.
- A figure the host has not reported is left out, never drawn as zero. The cache lifetime is never guessed: it comes from a model switch (`classic.PostModelSwitch`, the only event that names it) or the `cacheTtl` option.
- Next steps are off unless `nextSteps: true`. A step is model text that read untrusted content: it reaches the screen and the prompt box only through `clean`, a slash step must name a command the session has, and a pressed step only fills the prompt box, never sends.
- The busy dot shows only while a main turn runs and the host's `isWorking` agrees, so a turn whose completion never reached the card does not stay busy.
- The context percent is measured against the window the host compacts at, not the model's window.
