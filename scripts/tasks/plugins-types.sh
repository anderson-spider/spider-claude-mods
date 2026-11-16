#!/usr/bin/env bash
# npm run plugins:types [-- <name>...] — generate the claude-code typings the named plugins' (or every plugin's) tsconfig.json extends.
# Claude Code writes plugins/*/.claude-plugin/types/ only when an interactive session loads a plugin from its folder,
# so this opens one on a pseudo-terminal with the plugin (or every plugin) and exits once each has its typings.
# It runs your own claude, so the typings carry the version your sessions run; in CI, the pinned one.
set -euo pipefail
. scripts/tasks/lib.sh
use_own_claude
name=${*:-}
typed_plugin_dirs "$@"
args=()
for d in "${dirs[@]}"; do args+=(--plugin-dir "${d%/}"); done
ready() { for d in "${dirs[@]}"; do [ -f "${d}.claude-plugin/types/tsconfig.json" ] || return 1; done; }
# util-linux `script` (Linux) takes the command with -c; BSD `script` (macOS) takes it after the file.
# exec: the session's pid, which the pipeline below runs in the background, is then script's own, which it can stop.
pty() { if script --version >/dev/null 2>&1; then exec script -q -e -c "$(printf '%q ' "$@")" /dev/null; else exec script -q /dev/null "$@"; fi; }
# A config that has not been through the first-run screens (theme, folder trust), as on a CI runner or in a Claude Code
# cloud session, keeps the session on them: it never loads the plugins and the /exit below goes to a menu. Such a run
# gets a throwaway config marked past them; a config that has been through them is kept, with its MCP integrations.
config=${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json
if ! node -e 'const [file, dir] = process.argv.slice(1), c = JSON.parse(require("fs").readFileSync(file, "utf8"));
  process.exit(c.hasCompletedOnboarding && c.projects?.[dir]?.hasTrustDialogAccepted ? 0 : 1)' "$config" "$PWD" 2>/dev/null; then
  CLAUDE_CONFIG_DIR=$(mktemp -d)
  export CLAUDE_CONFIG_DIR
  trap 'rm -rf "$CLAUDE_CONFIG_DIR"' EXIT
  node -e 'const [dir, cwd] = process.argv.slice(1); require("fs").writeFileSync(dir + "/.claude.json",
    JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [cwd]: { hasTrustDialogAccepted: true } } }))' \
    "$CLAUDE_CONFIG_DIR" "$PWD"
fi
# The session is stopped if it is still open some time after /exit, so a screen it waits on fails the task, not hangs it.
{ for _ in $(seq 120); do ready && break; sleep 1; done; sleep 2; printf '/exit\r'; } | pty claude "${args[@]}" >/dev/null 2>&1 &
session=$!
for _ in $(seq 140); do kill -0 "$session" 2>/dev/null || break; sleep 1; done
kill "$session" 2>/dev/null || true
wait "$session" 2>/dev/null || true
ready || { echo "typings were not written for ${name:-every plugin}" >&2; exit 1; }
echo "typings written for ${name:-every plugin}"
