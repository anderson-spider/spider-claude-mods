# sonarqube

- Read only, with no generic API tool: GETs to fixed endpoints, and `tests/register.test.ts` pins the eight tools.
- The token goes only in `Authorization: Basic` (`token:`).
- `$.session.root()` is where the session started, not the repository's root: the project key is looked up from the session folder up to the folder holding `.git`.
- An issue of a branch or pull request is found by key only with its project in `componentKeys`.
- Pull requests need a commercial SonarQube edition.
- Live check (not in CI): with `SONAR_URL` and `SONAR_TOKEN` exported, `claude --plugin-dir plugins/sonarqube --allowedTools 'mcp__sonarqube__*' -p '<ask for each tool>'`; the prompt goes after `-p`, since `--allowedTools` takes several values.
