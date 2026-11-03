import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./bootstrap.sh", import.meta.url));
const MARKET = "spider-claude-mods";

// A `claude` that logs every call and keeps the marketplace and plugin lists in files, a `uname` that says `os`.
function world({ installed = [], marketplace = false, os = "Darwin" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(root, "calls.log");
  const plugins = join(root, "plugins.json");
  const markets = join(root, "markets.json");
  const entry = name => {
    const dir = join(root, "cache", MARKET, name, "1.0.0");
    mkdirSync(join(dir, "helper"), { recursive: true });
    writeFileSync(join(dir, "helper", "install.sh"), `#!/bin/sh\necho "${name}-helper $*" >> "${log}"\n`);
    return `  {"id": "${name}@${MARKET}", "installPath": "${dir}"}`;
  };
  const rows = installed.map(entry);
  writeFileSync(plugins, `[\n${rows.join(",\n")}\n]\n`);
  writeFileSync(markets, marketplace ? `[{"name": "${MARKET}"}]\n` : "[]\n");
  const claude = `#!/bin/sh
echo "claude $*" >> "${log}"
case "$1 $2 $3" in
  "plugin list --json") cat "${plugins}" ;;
  "plugin marketplace list") cat "${markets}" ;;
  "plugin marketplace add") echo '[{"name": "${MARKET}"}]' > "${markets}" ;;
  "plugin install "*)
    name=\${3%@*}
    dir="${root}/cache/${MARKET}/$name/1.0.0"
    mkdir -p "$dir/helper"
    printf '#!/bin/sh\\necho "%s-helper $*" >> "${log}"\\n' "$name" > "$dir/helper/install.sh"
    sed -i.bak '$d' "${plugins}" && rm -f "${plugins}.bak"
    printf '  {"id": "%s", "installPath": "%s"}\\n]\\n' "$3" "$dir" >> "${plugins}"
    ;;
esac
`;
  writeFileSync(join(bin, "claude"), claude);
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${os}\n`);
  const node = join(root, "node");
  writeFileSync(node, "#!/bin/sh\n");
  for (const f of [join(bin, "claude"), join(bin, "uname"), node]) chmodSync(f, 0o755);
  const run = (...args) => {
    const env = typeof args[0] === "object" ? args.shift() : {};
    const result = spawnSync("sh", [script, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, BOOTSTRAP_NODE: node, ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").map(l => l.trimEnd()).filter(Boolean) : [];
    return { ...result, calls };
  };
  return { run, root };
}

// The plugin list bootstrap.sh installs; check-consistency keeps it equal to marketplace.json.
const ALL = /^ALL="([^"]*)"$/m.exec(readFileSync(script, "utf8"))[1].split(" ");
const mutating = calls => calls.filter(c => /plugin (install|update|uninstall|marketplace add|marketplace update)|-helper/.test(c));

test("--check prints the steps and changes nothing", () => {
  const w = world();
  try {
    const r = w.run("--check");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), []);
    assert.match(r.stdout, /would: claude plugin marketplace add anderson-spider\/claude-mods/);
    for (const p of ALL) {
      assert.match(r.stdout, new RegExp(`would: claude plugin install ${p}@${MARKET} --scope user`));
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a fresh machine: marketplace added, every plugin installed, the helper of codex's computer use installed", () => {
  const w = world();
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), [
      "claude plugin marketplace add anderson-spider/claude-mods",
      ...ALL.map(p => `claude plugin install ${p}@${MARKET} --scope user`),
      "codex-helper",
    ]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a second run updates what is installed and runs the codex helper", () => {
  const w = world({ installed: ALL, marketplace: true });
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), [
      `claude plugin marketplace update ${MARKET}`,
      ...ALL.map(p => `claude plugin update ${p}@${MARKET} --scope user`),
      "codex-helper",
    ]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("--only limits the plugins, and an unknown name or flag is refused before anything runs", () => {
  const w = world({ marketplace: true });
  try {
    const only = w.run("--only", "tailscale");
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(mutating(only.calls), [`claude plugin marketplace update ${MARKET}`, `claude plugin install tailscale@${MARKET} --scope user`]);
    assert.match(only.stdout, /tailscale needs its apiKey/);
    assert.doesNotMatch(only.stdout, /codex-cu status/);
    const cu = w.run("--only", "codex");
    assert.equal(cu.status, 0, cu.stderr);
    assert.deepEqual(mutating(cu.calls).slice(-2), [`claude plugin install codex@${MARKET} --scope user`, "codex-helper"]);
    assert.match(cu.stdout, /`\/codex-cu status` should report the helper running/);
    assert.doesNotMatch(cu.stdout, /tailscale/);
    const unknown = w.run("--only", "nope");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown plugin 'nope'/);
    const flag = w.run("--bogus");
    assert.equal(flag.status, 2);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("off macOS every plugin is installed, codex without the computer use helper or its next step", () => {
  const w = world({ os: "Linux" });
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), [
      "claude plugin marketplace add anderson-spider/claude-mods",
      ...ALL.map(p => `claude plugin install ${p}@${MARKET} --scope user`),
    ]);
    assert.doesNotMatch(r.stdout, /left out|codex-cu/);
    assert.match(r.stdout, /gitlab needs its tokens/);
    const codex = w.run("--only", "codex");
    assert.equal(codex.status, 0, codex.stderr);
    assert.doesNotMatch(codex.stdout, /codex-cu/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("the former codex-computer-use plugin is uninstalled, since codex took it over", () => {
  const w = world({ installed: ["codex", "codex-computer-use"], marketplace: true });
  try {
    const r = w.run("--only", "codex");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), [
      `claude plugin marketplace update ${MARKET}`,
      `claude plugin uninstall codex-computer-use@${MARKET} --scope user`,
      `claude plugin update codex@${MARKET} --scope user`,
      "codex-helper",
    ]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a helper that cannot install is a warning: the run still ends with its next steps", () => {
  const w = world({ installed: ["codex"], marketplace: true });
  try {
    const dir = join(w.root, "cache", MARKET, "codex", "1.0.0", "helper");
    writeFileSync(join(dir, "install.sh"), "#!/bin/sh\necho 'codex-cu: the Codex computer-use configuration failed its check' >&2\nexit 1\n");
    const r = w.run("--only", "codex");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warn: codex helper not installed: computer use stays unavailable/);
    assert.match(r.stdout, /done\. Next:/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("BOOTSTRAP_SOURCE replaces the GitHub repository as the marketplace source", () => {
  const w = world({ os: "Linux" });
  try {
    const r = w.run({ BOOTSTRAP_SOURCE: "/src/claude-mods" }, "--only", "gitlab");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutating(r.calls), ["claude plugin marketplace add /src/claude-mods", `claude plugin install gitlab@${MARKET} --scope user`]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
