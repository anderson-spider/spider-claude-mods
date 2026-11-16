# verification-planning

Usage/privacy: [README.md](README.md).
- Ships only the skill `skills/verification-planning/SKILL.md` (no `hooks/`, no `tsconfig.json`), so `claude plugin test` and `tsc` skip it; its frontmatter `name` must stay `verification-planning`, the folder's name.
- The skill is generic on purpose: no project, tool or host of anyone's in it. Its one outside reference is the optional `research` skill, with an Explore subagent as the fallback.
- Checks: [root commands](../../AGENTS.md#commands).
