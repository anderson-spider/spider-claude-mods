import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isReleasePr, shippedPlugins, titleErrors, touchedPlugins, versionEdits } from "./check-release.mjs";

const script = fileURLToPath(new URL("./check-release.mjs", import.meta.url));

// Files under a plugin that ship, one per folder the plugins use.
const COUNTED = [
  "hooks/register.tsx",
  "hooks/hud/view.ts",
  "hooks/hooks.json",
  "helper/helper.mjs",
  "helper/lib/hub.mjs",
  "skills/brainstorm/SKILL.md",
  "skills/brainstorm/references/notes.md",
  "types/index.d.ts",
  ".claude-plugin/plugin.json",
  "tsconfig.json",
  "agents/reviewer.md",
  "scripts/build.sh",
];
// Tests and docs: they never change what a user runs.
const EXCLUDED = [
  "tests/register.test.ts",
  "tests/fixtures/data.json",
  "helper/test/config.test.mjs",
  "helper/test/contract.mjs",
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "docs/design.png",
  "hooks/api.test.ts",
];

for (const path of COUNTED) {
  test(`counts a change to plugins/alpha/${path}`, () => {
    assert.deepEqual(shippedPlugins([`plugins/alpha/${path}`]), ["alpha"]);
  });
}

for (const path of EXCLUDED) {
  test(`ignores a change to plugins/alpha/${path}`, () => {
    assert.deepEqual(shippedPlugins([`plugins/alpha/${path}`]), []);
  });
}

test("files outside plugins/<name>/ never count", () => {
  assert.deepEqual(
    shippedPlugins([
      "README.md",
      "AGENTS.md",
      "scripts/check-release.mjs",
      ".github/workflows/ci.yml",
      "notes/alpha.md",
      ".claude-plugin/marketplace.json",
      "plugins/README.md",
      "plugins/alpha",
      "docs/plugins/alpha/hooks/a.ts",
      "vendor/plugins/alpha/hooks/a.ts",
    ]),
    [],
  );
});

test("a plugin counts once however many files changed, and each plugin is its own", () => {
  assert.deepEqual(
    shippedPlugins([
      "plugins/zeta/hooks/a.ts",
      "plugins/alpha/hooks/a.ts",
      "plugins/alpha/skills/s/SKILL.md",
      "plugins/alpha/tests/a.test.ts",
      "plugins/beta/README.md",
      "plugins/gamma/AGENTS.md",
      "plugins/gamma/tests/a.test.ts",
    ]),
    ["alpha", "zeta"],
  );
});

/** A version lookup over `{ base: { name: version }, head: { name: version } }`. */
const versions = (table) => (side, name) => table[side][name];

test("a version edited by hand is reported with the version to leave", () => {
  assert.deepEqual(versionEdits(["plugins/alpha/.claude-plugin/plugin.json"], versions({ base: { alpha: "1.0.0" }, head: { alpha: "1.0.1" } })), [
    "alpha: version changed from 1.0.0 to 1.0.1; leave it at 1.0.0, the release pull request sets it",
  ]);
});

test("shipped files changed at the same version pass, and so does a removed plugin", () => {
  const changed = ["plugins/alpha/hooks/a.ts", "plugins/gone/hooks/a.ts", "plugins/beta/README.md"];
  assert.deepEqual(versionEdits(changed, versions({ base: { alpha: "1.0.0", gone: "2.0.0", beta: "3.0.0" }, head: { alpha: "1.0.0", beta: "3.0.0" } })), []);
});

test("a new plugin starts at 0.0.0", () => {
  const changed = ["plugins/fresh/.claude-plugin/plugin.json", "plugins/early/.claude-plugin/plugin.json"];
  assert.deepEqual(versionEdits(changed, versions({ base: {}, head: { fresh: "0.0.0", early: "0.1.0" } })), [
    "early: a new plugin starts at 0.0.0, not 0.1.0; its first release sets the version",
  ]);
});

test("a title whose type releases passes when shipped files changed, with or without a scope or a !", () => {
  for (const title of ["fix: a", "feat(alpha): a", "perf(alpha,beta): a", "refactor: a", "revert: a", "chore!: a", "feat(alpha)!: a"]) {
    assert.deepEqual(titleErrors(title, ["alpha"]), [], title);
  }
});

test("a title whose type opens no release passes when no shipped file changed", () => {
  for (const title of ["chore: a", "docs(alpha): a", "test: a", "ci: a", "build: a", "style: a"]) {
    assert.deepEqual(titleErrors(title, []), [], title);
  }
});

test("a quiet type over shipped files names the plugins and the types to use", () => {
  assert.deepEqual(titleErrors("chore(alpha): tidy", ["alpha", "beta"]), [
    'title type "chore" opens no release, but shipped files changed in alpha, beta: use one of feat, fix, perf, refactor, revert',
  ]);
});

test("a releasing type or a ! with no shipped file changed names the types to use", () => {
  assert.deepEqual(titleErrors("fix(alpha): typo in the README", []), [
    'title type "fix" opens a release, but no plugin\'s shipped files changed: use one of build, chore, ci, docs, style, test',
  ]);
  assert.deepEqual(titleErrors("chore!: drop a script", []), [
    'title type "chore!" opens a release, but no plugin\'s shipped files changed: use one of build, chore, ci, docs, style, test',
  ]);
});

test("a releasing title over one plugin's shipped files and only another's tests or docs names the other", () => {
  const files = ["plugins/alpha/hooks/a.ts", "plugins/alpha/tests/a.test.ts", "plugins/beta/README.md", "plugins/gamma/tests/a.test.ts", "README.md"];
  assert.deepEqual(touchedPlugins(files), ["alpha", "beta", "gamma"]);
  assert.deepEqual(titleErrors("fix(alpha): a", shippedPlugins(files), touchedPlugins(files)), [
    'title type "fix" opens a release, but only tests or docs changed in beta, gamma: move that to a pull request of its own',
  ]);
  assert.deepEqual(titleErrors("docs: a", [], ["beta", "gamma"]), []);
});

test("a title that is not a Conventional Commit is reported whatever changed", () => {
  for (const title of ["Fix the thing", "fix:", "fix:no space", "wip: a", "fix (alpha): a", ""]) {
    for (const shipped of [[], ["alpha"]]) {
      assert.match(titleErrors(title, shipped)[0], /is not a Conventional Commit: write type\(scope\): description, with type one of feat, fix, perf, refactor, revert, build, chore, ci, docs, style, test$/, title);
    }
  }
});

test("the release pull request is the bot's, from release-please's branch; either alone is not", () => {
  const bot = "releaser[bot]";
  assert.equal(isReleasePr({ author: bot, head: "release-please--branches--main" }, bot), true);
  assert.equal(isReleasePr({ author: "someone", head: "release-please--branches--main" }, bot), false);
  assert.equal(isReleasePr({ author: bot, head: "feature" }, bot), false);
  assert.equal(isReleasePr({ author: undefined, head: undefined }, undefined), false);
  assert.equal(isReleasePr({ author: "", head: "release-please--branches--main" }, ""), false);
});

// The command, against a real repository: main with two plugins, then a branch that changes them.
function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "check-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const manifest = (name, version) => JSON.stringify({ name, version });
  git("init", "-q", "-b", "main");
  write("plugins/alpha/.claude-plugin/plugin.json", manifest("alpha", "1.0.0"));
  write("plugins/alpha/hooks/register.tsx", "export {};\n");
  write("plugins/beta/.claude-plugin/plugin.json", manifest("beta", "2.0.0"));
  write("plugins/beta/hooks/register.tsx", "export {};\n");
  write("plugins/beta/skills/s/SKILL.md", "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "work");
  };
  const move = (from, to) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    git("mv", from, to);
    git("commit", "-q", "-m", "move");
  };
  const remove = (path) => {
    git("rm", "-rq", path);
    git("commit", "-q", "-m", "remove");
  };
  // The pull request variables are dropped from the environment, so a run inside CI checks only what `pr` gives.
  const { PR_TITLE, PR_AUTHOR, PR_HEAD, RELEASE_BOT, ...clean } = process.env;
  const runIn = (dir, pr, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: join(root, dir), encoding: "utf8", env: { ...clean, ...pr } });
  const run = (pr, ...args) => runIn(".", pr, ...args);
  return { write, manifest, commit, move, remove, run, runIn };
}

test("the command exits 2 with usage when no base ref is given, and on an unknown option", (t) => {
  const repo = fixtureRepo(t);
  const result = repo.run({});
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "usage: node scripts/check-release.mjs <base-ref> [--worktree]\n");
  assert.equal(repo.run({}, "main", "--staged").status, 2);
});

test("without a title the command checks only the versions", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/hooks/register.tsx", "export const a = 1;\n");
  repo.commit();
  const result = repo.run({}, "main");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok: no plugin version was edited\n");
  assert.equal(result.stderr, "");
});

test("the command passes a releasing title over a changed skill and a quiet title over tests and docs", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/tests/a.test.ts", "test\n");
  repo.write("plugins/beta/AGENTS.md", "docs\n");
  repo.commit();
  assert.equal(repo.run({ PR_TITLE: "test(alpha): cover a" }, "main").status, 0);
  assert.equal(repo.run({ PR_TITLE: "fix(alpha): a" }, "main").status, 1);
  repo.write("plugins/beta/skills/s/SKILL.md", "two\n");
  repo.commit();
  const mixed = repo.run({ PR_TITLE: "fix(beta): say two" }, "main");
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /but only tests or docs changed in alpha: /);
  repo.write("plugins/alpha/hooks/register.tsx", "export const a = 1;\n");
  repo.commit();
  const result = repo.run({ PR_TITLE: "fix(beta): say two" }, "main");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok: no plugin version was edited and the title matches what changed\n");
});

test("the command fails on a hand-edited version and a quiet title at once, one line each", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/hooks/register.tsx", "export const a = 1;\n");
  repo.write("plugins/alpha/.claude-plugin/plugin.json", repo.manifest("alpha", "1.0.1"));
  repo.commit();
  const result = repo.run({ PR_TITLE: "chore(alpha): a" }, "main");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      "alpha: version changed from 1.0.0 to 1.0.1; leave it at 1.0.0, the release pull request sets it",
      'title type "chore" opens no release, but shipped files changed in alpha: use one of feat, fix, perf, refactor, revert',
      "",
    ].join("\n"),
  );
});

test("the release pull request passes with its edited versions and its chore title, and nobody else's does", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/.claude-plugin/plugin.json", repo.manifest("alpha", "1.0.1"));
  repo.write("plugins/alpha/CHANGELOG.md", "# Changelog\n");
  repo.commit();
  const pr = { PR_TITLE: "chore: release main", PR_HEAD: "release-please--branches--main", RELEASE_BOT: "releaser[bot]" };
  const result = repo.run({ ...pr, PR_AUTHOR: "releaser[bot]" }, "main");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok: the release pull request\n");
  assert.equal(repo.run({ ...pr, PR_AUTHOR: "someone" }, "main").status, 1);
  assert.equal(repo.run({ ...pr, PR_AUTHOR: "", RELEASE_BOT: "" }, "main").status, 1);
});

test("a new plugin at 0.0.0 passes under a releasing title, and removing a plugin passes under a quiet one", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.0.0"));
  repo.write("plugins/fresh/hooks/register.tsx", "export {};\n");
  repo.commit();
  assert.equal(repo.run({ PR_TITLE: "feat(fresh): add the plugin" }, "main").status, 0);
  repo.remove("plugins/fresh");
  repo.remove("plugins/beta");
  assert.equal(repo.run({ PR_TITLE: "chore: remove the beta plugin" }, "main").status, 0);
});

// A move is a removal at the old path: git reports a rename by its destination alone unless told not to.
for (const { name, from, to, plugin } of [
  { name: "a skill moved to docs/", from: "plugins/beta/skills/s/SKILL.md", to: "plugins/beta/docs/s.md", plugin: "beta" },
  { name: "a hook moved to tests/", from: "plugins/alpha/hooks/register.tsx", to: "plugins/alpha/tests/register.tsx", plugin: "alpha" },
  { name: "a hook moved to another plugin", from: "plugins/alpha/hooks/register.tsx", to: "plugins/beta/hooks/moved.tsx", plugin: "alpha, beta" },
]) {
  test(`the command fails a quiet title when ${name}`, (t) => {
    const repo = fixtureRepo(t);
    repo.move(from, to);
    const result = repo.run({ PR_TITLE: "chore: move a file" }, "main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`opens no release, but shipped files changed in ${plugin}: `));
  });
}

test("an uncommitted version edit fails only with --worktree, which reads it from disk", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/.claude-plugin/plugin.json", repo.manifest("alpha", "1.0.1"));
  assert.equal(repo.run({}, "main").status, 0);
  const result = repo.run({}, "main", "--worktree");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "alpha: version changed from 1.0.0 to 1.0.1; leave it at 1.0.0, the release pull request sets it\n");
});

test("--worktree counts an untracked new plugin and still counts committed changes on the branch", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.1.0"));
  assert.match(repo.run({}, "main", "--worktree").stderr, /^fresh: a new plugin starts at 0\.0\.0, not 0\.1\.0; /);
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.0.0"));
  assert.equal(repo.run({}, "main", "--worktree").status, 0);
  repo.write("plugins/beta/.claude-plugin/plugin.json", repo.manifest("beta", "2.1.0"));
  repo.commit();
  assert.equal(repo.run({}, "main", "--worktree").status, 1);
});

test("--worktree from a subdirectory still sees untracked files elsewhere and reads the manifest from the root", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.1.0"));
  const failed = repo.runIn("plugins/alpha", {}, "main", "--worktree");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^fresh: a new plugin starts at 0\.0\.0, not 0\.1\.0; /);
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.0.0"));
  assert.equal(repo.runIn("plugins/alpha", {}, "main", "--worktree").status, 0);
});
