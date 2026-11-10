import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo } from "./check-consistency.mjs";
import { movePin, newer, pinnedCli } from "./bump-cli.mjs";

const script = fileURLToPath(new URL("./bump-cli.mjs", import.meta.url));
const manifest = `{
  "name": "sample",
  "private": true,
  "devDependencies": {
    "@anthropic-ai/claude-code": "2.1.322",
    "typescript": "7.0.2"
  }
}
`;
const readme = "Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.322 (`claude --version`).\n";

test("movePin sets the version in package.json and in the README sentence, and nothing else", () => {
  const moved = movePin({ manifest, readme }, "2.1.340");

  assert.equal(pinnedCli(moved.manifest), "2.1.340");
  assert.equal(moved.manifest, manifest.replace("2.1.322", "2.1.340"));
  assert.equal(moved.readme, "Requires Claude Code v2.1.287 or later. The repository is checked with v2.1.340 (`claude --version`).\n");
});

test("movePin refuses a range or a tag, and a README without the sentence", () => {
  for (const version of ["^2.1.340", "latest", "2.1", ""]) assert.throws(() => movePin({ manifest, readme }, version), /not an exact version/);
  assert.throws(() => movePin({ manifest, readme: "# sample\n" }, "2.1.340"), /checked with/);
});

test("newer compares the parts as numbers", () => {
  assert.equal(newer("2.1.323", "2.1.322"), true);
  assert.equal(newer("2.1.100", "2.1.99"), true);
  assert.equal(newer("3.0.0", "2.9.9"), true);
  assert.equal(newer("2.1.322", "2.1.322"), false);
  assert.equal(newer("2.1.99", "2.1.100"), false);
  assert.equal(newer("2.0.400", "2.1.0"), false);
});

/** A repository holding only what the script and check-consistency's pin rule read. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bump-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), manifest);
  writeFileSync(join(root, "README.md"), readme);
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, BUMP_CLI_ROOT: root } });
/** Runs the CLI with an `npm` first on PATH that answers `view` with `latest` and does what `install` says: "ok" or "fail". */
function runWithNpm(t, root, { latest = "", install }, ...args) {
  const bin = mkdtempSync(join(tmpdir(), "bump-cli-npm-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nif [ "$1" = view ]; then echo "${latest}"; exit 0; fi\n${install === "ok" ? "exit 0" : "echo no such version >&2; exit 1"}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, BUMP_CLI_ROOT: root, PATH: `${bin}${delimiter}${process.env.PATH}` } });
}

test("the CLI says nothing on stdout when the pin is already at the version asked for, and changes no file", (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, "package.json"), "utf8");

  const result = run(root, "2.1.322");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /already at 2\.1\.322/);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), readme);
});

test("the CLI fails on a version that is not exact, and on extra arguments", (t) => {
  const root = fixture(t);

  assert.equal(run(root, "latest").status, 1);
  assert.match(run(root, "2.1.340", "more").stderr, /usage:/);
  assert.equal(pinnedCli(readFileSync(join(root, "package.json"), "utf8")), "2.1.322");
});

test("the texts movePin returns pass check-consistency's pin rule", (t) => {
  const root = fixture(t);
  const moved = movePin({ manifest, readme }, "2.1.340");
  writeFileSync(join(root, "package.json"), moved.manifest);
  writeFileSync(join(root, "README.md"), moved.readme);
  // checkRepo needs a marketplace; only the pin lines matter here.
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "market", owner: { name: "me" }, plugins: [] }));

  assert.deepEqual(checkRepo(root).errors.filter((line) => line.includes("claude-code")), []);
});

test("with no version the CLI moves to npm's latest when it is newer, and prints it", (t) => {
  const root = fixture(t);

  const result = runWithNpm(t, root, { latest: "2.1.340", install: "ok" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2.1.340\n");
  assert.equal(pinnedCli(readFileSync(join(root, "package.json"), "utf8")), "2.1.340");
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /checked with v2\.1\.340 /);
});

test("with no version the CLI does not follow a latest older than the pin, but a version asked for by name moves it back", (t) => {
  const root = fixture(t);

  const followed = runWithNpm(t, root, { latest: "2.1.300", install: "ok" });

  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(followed.stdout, "");
  assert.match(followed.stderr, /stays at 2\.1\.322/);
  assert.equal(pinnedCli(readFileSync(join(root, "package.json"), "utf8")), "2.1.322");

  const asked = runWithNpm(t, root, { install: "ok" }, "2.1.300");

  assert.equal(asked.stdout, "2.1.300\n");
  assert.equal(pinnedCli(readFileSync(join(root, "package.json"), "utf8")), "2.1.300");
});

test("when npm cannot rewrite the lockfile the CLI fails and leaves package.json and the README as they were", (t) => {
  const root = fixture(t);

  const result = runWithNpm(t, root, { install: "fail" }, "2.1.340");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), manifest);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), readme);
});
