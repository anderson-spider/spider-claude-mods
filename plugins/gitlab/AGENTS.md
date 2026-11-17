# gitlab

An MCP server with no hooks (so Code Mode stays available) and no dependencies. Node 22.18 or later runs `server/main.ts` by stripping types: imports carry `.ts`, and only erasable syntax is allowed. Tests run with `node --test`, since `claude plugin test` needs a hooks module.

## Invariants

- No generic API tool and no delete action (merge's `removeSourceBranch` aside); a new need gets its own action or tool. `tests/run.test.ts` pins the tool set.
- API paths are built from checked ids and the encoded project, never from model text.
- One token per host, sent only to its own host in `PRIVATE-TOKEN`, masked as `[token]` in any echo. A redirect to another origin drops it. Refused when the repository's settings declare the token source or cannot be read. `host` is a host name, never a URL, and a remote URL is never echoed.
- Every write on an MR reads it first and is refused when its author is not the token's user, unless `allowOthers: true`.
- Merge needs an explicit `iid` and the full head `sha`, and is refused for a draft, conflicts, blocking discussions or a closed MR whatever the flags. A `release*` target, or a protected one other than main, master or develop, needs `allowProtectedTarget: true`; protection that cannot be read refuses the merge.
- Labels must exist before an MR gets them, unless `createMissingLabels: true`, so GitLab never creates one silently.
- `create` opens ready and assigned to `@me` by default.

## Skill

Keep `skills/gitlab/SKILL.md`'s tool names, actions and inputs in step with `server/inputs.ts`, and its triggers free of work hosts.
