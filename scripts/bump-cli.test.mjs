import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo } from "./check-consistency.mjs";
import { movePin, pinnedCli } from "./bump-cli.mjs";

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

/** A repository holding only what the script and check-consistency's pin rule read. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bump-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), manifest);
  writeFileSync(join(root, "README.md"), readme);
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, BUMP_CLI_ROOT: root } });

test("the CLI says nothing on stdout when the pin is already at the version asked for, and changes no file", (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, "package.json"), "utf8");

  const result = run(root, "2.1.322");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /already at 2\.1\.322/);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
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
