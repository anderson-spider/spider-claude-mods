# github

A skill, `github:github`, that has Claude do GitHub work itself, in the main agent, with the [`gh`](https://cli.github.com/) CLI: pull requests, pending reviews, Actions runs and workflow logs, issues and comments.

```text
/plugin install github --marketplace anderson-spider/claude-mods
```

It needs `gh` on your `PATH`, logged in (`gh auth login`) to the accounts whose repositories you work on.

## Use

Claude loads the skill by itself when you paste a `github.com` URL or mention a pull request, an Actions run or a workflow failure, and you can run it with `/github:github` (or `/github` when no other command has that name). It never handles GitLab; the `gitlab` plugin does.

- **Pull requests** are created ready (never as drafts) and assigned to you, with an English Conventional Commits title. The repository's own rules (CLAUDE.md, AGENTS.md, CONTRIBUTING, templates, commit lint) come first.
- **Pending reviews** are created without an `event`, so only you see them until you submit them. An existing pending review is deleted only when you say to replace it.
- **Runs** are checked once and reported as they are: the skill never waits, polls or watches. Logs come back as the failing excerpts with a diagnosis.
- **Writes** that cannot be undone (force-push, merge, close, delete) happen only when you ask for them.

Review comments are written in the language you write to Claude in and go through the `humanizer` skill first when it is installed; that skill is not part of this marketplace.

## Privacy

The skill runs `gh` with your own login, so it can read and change whatever that login can. It sends nothing anywhere else.

## Tests

The plugin ships only a skill, so `claude plugin test` has nothing to run. `claude plugin validate --strict` checks its manifest and frontmatter.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
