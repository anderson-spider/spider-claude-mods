# github

Usage/privacy: [README.md](README.md).
- Ships only the skill `skills/github/SKILL.md` (no `hooks/`, no `tsconfig.json`), so `claude plugin test` and `tsc` skip it; its frontmatter `name` must stay `github`, the folder's name.
- Other skills name it `github:github`: `antigravity:review-publish` posts pending reviews the way its "Pending reviews" section describes, so keep that section's payload shape (`commit_id`, `body`, `comments` with `path`, `line`, `side`, `body`, no `event`) in step with `plugins/antigravity/skills/review-publish/`.
- Checks: [root commands](../../AGENTS.md#commands).
