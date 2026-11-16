# verification-planning

A skill, `verification-planning:verification-planning`, that has Claude plan how it will prove a non-trivial change before making it, and report afterwards what the evidence established.

```text
/plugin install verification-planning --marketplace anderson-spider/claude-mods
```

## Use

Claude loads the skill by itself before a feature, bug fix, refactor or cross-system change that needs evidence specific to the project, and you can run it with `/verification-planning:verification-planning` (or `/verification-planning` when no other command has that name). It walks through:

1. The claim: what must become true, what must stay true, and which failure would matter most.
2. The evidence path: how this system can show the claim true or false, chosen among alternatives for its cost and trust.
3. A verification budget: one owner for each claim, and the least evidence that covers them without duplicates.
4. A verification affordance, when the system hides the truth: the smallest capability that makes the state controllable and observable, kept or removed on purpose.
5. Research, when the path depends on something unfamiliar: the `research` skill when installed (it is not part of this marketplace), else an Explore subagent.
6. Closing the path after the change: established, limited or refuted, and what remains uncertain.

Small mechanical changes skip it and follow the project's ordinary checks. It asks before adding dependencies or lasting diagnostic code whose only purpose is evidence.

## Privacy

The skill is instructions only: it reads and runs nothing by itself, and Claude uses its ordinary tools under your permission rules.

## Tests

The plugin ships only a skill, so `claude plugin test` has nothing to run. `claude plugin validate --strict` and `scripts/check-consistency.mjs` check its manifest and frontmatter.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
