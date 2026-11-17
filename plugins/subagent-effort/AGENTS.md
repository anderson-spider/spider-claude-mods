# subagent-effort

The hook never rewrites an `Agent` call: auto mode (server review, Claude Code v2.1.271 and later) reviews the call the model wrote and refuses one a hook changed afterwards, and `agent.spawn` takes a model but no effort. So a call without Jev's effort is refused with the effort to use, its input untouched, and after `ASK_AGAIN` refusals it goes as it came, so a model that will not follow never loops.

## Invariants

- Only the effort is Jev's: no other field of a call changes. Jev off, failing, or any routing failure dispatches the call as it came.
- The ledger is the plugin's only file. A line never holds the task, a prompt, an answer, a path or the key; the brief appears only as its length. Host error text never reaches it, only its class.
- Bump `CALIBRATION` with any change to `QUESTION`, `EFFORTS` or `POLICY`; the summary compares only runs of the current calibration.
- Change an `EVAL_BRIEFS` label only after reviewing why Jev disagreed.
- The stats texts carry no plugin-name prefix: the host adds it.

Fake-host coverage is not evidence of live routing.
