# Releases come from pull request titles, through release-please

Plugin versions were edited by hand in every pull request, with a check that the version changed but not by how much, and nothing produced a changelog, a tag or a GitHub release. We decided that the squash commit's Conventional Commit title is the only input: release-please, in manifest mode, turns the titles on `main` into each plugin's next version, changelog, tag and release through one release pull request that merges by itself.

## Considered Options

- **semantic-release**: it assumes one package versioned in `package.json` and pushes its release commit to the branch. Here there are several plugins versioned in `.claude-plugin/plugin.json`, and the ruleset of `main` has no bypass actor, so nothing can push to it outside a pull request.
- **A script of our own**: it would read `NOT_SHIPPED` directly, but the version arithmetic, the changelog, the release pull request, the tags and the releases would all be ours to write and test.
- **The bump committed to each pull request's branch by a bot**: no second pull request, but the bot writes to the author's branch and two open pull requests for one plugin conflict in `plugin.json`.

## Consequences

- A commit belongs to every plugin whose folder it changed; the title's scope is never read. A change to the `hooks/schema.ts` copies releases every plugin that has one, and a scope that names the wrong plugin changes nothing.
- release-please cannot leave a plugin's root `.md` files out of a release, so `scripts/check-release.mjs` makes the title's type agree with the files instead: a releasing type exactly when a shipped file changed. A `fix` that only touches a plugin's README is refused rather than released, and so is one that ships a change to one plugin while touching only the tests or docs of another.
- The repository must squash with the pull request title as the commit title and an empty body, and the release pull request must be opened with a GitHub App's token, since one opened with `GITHUB_TOKEN` runs no checks.
