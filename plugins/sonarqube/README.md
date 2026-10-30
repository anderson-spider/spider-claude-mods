# sonarqube

Diagnose SonarQube 9.x analyses through the server's read-only Web API: the quality gate of a branch or pull request, the measures and issues behind it, the rule of an issue, security hotspots, and the analyzed branches and pull requests. The tools only read; nothing is changed on the server. It speaks the 9.x API (issue `types` and `severities`, before Clean Code attributes) and is checked against SonarQube 9.2.4.

```text
/plugin install sonarqube --marketplace anderson-spider/claude-mods
```

## Setup

The server and token come from the first of these that gives both:

1. The plugin options, from the plugin's configuration in `/plugin` (or `claude plugin configure sonarqube`), in your user options, not in a repository's settings:
   - `url`: your server's https address, such as `https://sonarqube.example.com`, with its context path if it runs under one (`https://example.com/sonar`). Plain `http`, credentials, a query or a fragment are refused.
   - `token` (sensitive, kept in secure storage): a user token from **My Account > Security** that can browse the projects you want to read.
2. `SONARQUBE_URL` and `SONARQUBE_TOKEN` in the environment Claude Code starts with.
3. `SONAR_URL` and `SONAR_TOKEN`.

A source counts only with both values: setting just one option is refused instead of falling back, and a url from one source never receives the token of another. With no source the tools answer with an error that says where to set them.

## Use

- `mcp__sonarqube__sonarqube_quality_gate`: the gate's status and every condition with its actual value and threshold. Start here when an analysis failed.
- `mcp__sonarqube__sonarqube_measures`: up to 20 metrics (`new_coverage`, `new_branch_coverage`, `bugs`, ...); a new-code period value takes precedence, and metrics with no value are listed in `noValue`.
- `mcp__sonarqube__sonarqube_issues`: issues, paged (`page`, `pageSize` up to 100), open ones unless `statuses` says otherwise, filtered by `severities` and `type`.
- `mcp__sonarqube__sonarqube_issue`: one open issue by key, or `null` when it is resolved, closed or absent. For an issue of a branch or pull request, pass that scope.
- `mcp__sonarqube__sonarqube_rule`: a rule's name, type, severity, tags and description (with its compliant and noncompliant examples) as text.
- `mcp__sonarqube__sonarqube_hotspots`: security hotspots, paged, those to review unless `status` is `REVIEWED`.
- `mcp__sonarqube__sonarqube_branches`: analyzed branches and pull requests with each one's gate, the main branch first and then the newest, 30 of each; `branch` keeps one branch and the pull requests from it, which gives the pull request key of a source branch.

Every tool but `sonarqube_rule` takes `projectKey`; without it, the plugin reads `sonar.projectKey` from the nearest `sonar-project.properties`, from the session's folder up to the root of its git working tree. The scoped tools take `branch` or `pullRequest` (never both); with neither they read the main branch. Answers are compact JSON, cut past 60,000 characters.

A diagnosis usually goes: `sonarqube_quality_gate` for the scope of the failing analysis, `sonarqube_measures` for the failed conditions' metrics, then `sonarqube_issues` (and `sonarqube_rule` for how to fix one) when the gate points at issues.

## Privacy

The token is sent only to the configured server, in the `Authorization` header (HTTP Basic, the token as the user and an empty password, as SonarQube 9.x takes it), and the plugin's own messages never include it or the url. Each call is a GET to one fixed endpoint with its query built by the plugin; no input chooses a path or a host. On every call the plugin reads the user, project and local settings, and refuses the call without sending anything when the project or local settings declare, with a value your user settings do not give, the `url` or `token` option (when the options are in use) or the environment variables of the pair in use (`env`), or when the settings cannot be read: a repository could otherwise send your token to a host it chose. A value equal to your own is accepted, so a session opened in your home folder, where the project settings are your own `~/.claude/settings.json`, still works.

The plugin reads the environment variables named above, the session's folder and the `sonar-project.properties` and `.git` entries above it, and nothing else on disk.

## Tests

Pure tests cover the url and token sources and refusals, the API client (header, query, error answers), project detection and each tool's request and answer, with a fake SonarQube; host tests run the plugin against a fake host with no network. They do not exercise a real server.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
