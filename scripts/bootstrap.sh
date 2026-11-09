#!/bin/sh
# One-step setup of this marketplace: adds it, installs or updates every plugin and, on macOS, installs the helper
# of codex's computer use (a LaunchAgent) from the installed plugin. Elsewhere codex is installed without it, since
# computer use controls native Mac apps. Safe to run again.
#
#   bootstrap.sh                     everything below
#   bootstrap.sh --only tailscale,codex only those plugins
#   bootstrap.sh --check             prints what it would do and checks the prerequisites; changes nothing
#
# BOOTSTRAP_SOURCE replaces the GitHub repository as the marketplace source (a local checkout, for a test install).
#
# Run it straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh
# Arguments go after `sh -s --`.
#
# Secrets are never handled here: set them yourself with `claude plugin configure <plugin>`.
set -eu

MARKET=spider-claude-mods
REPO=${BOOTSTRAP_SOURCE:-anderson-spider/claude-mods}
# Every plugin of the marketplace; check-consistency keeps this list equal to marketplace.json.
ALL="antigravity codex comfyui-local coolify file-explorer gitlab image-preview session-hud sonarqube subagent-effort tailscale"
NODE=${BOOTSTRAP_NODE:-/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node}
ONLY=
CHECK=

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --only) [ $# -ge 2 ] || { echo "usage: bootstrap.sh [--check] [--only a,b]" >&2; exit 2; }; ONLY=$2; shift 2 ;;
    *) echo "usage: bootstrap.sh [--check] [--only a,b]" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# A step that changes something: printed alone under --check.
act() {
  if [ -n "$CHECK" ]; then printf 'would: %s\n' "$*"; else "$@"; fi
}

command -v claude >/dev/null 2>&1 || fail "claude is not on PATH; install Claude Code first"
MAC=
[ "$(uname -s)" = Darwin ] && MAC=1

if [ -n "$ONLY" ]; then
  PLUGINS=$(printf '%s' "$ONLY" | tr ',' ' ')
  for p in $PLUGINS; do
    case " $ALL " in *" $p "*) ;; *) fail "unknown plugin '$p' (one of: $ALL)" ;; esac
  done
else
  PLUGINS=$ALL
fi

say "marketplace $MARKET"
if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": *\"$MARKET\""; then
  act claude plugin marketplace update "$MARKET"
else
  act claude plugin marketplace add "$REPO"
fi

LISTED=$(claude plugin list --json 2>/dev/null || true)
# codex took over codex-computer-use; both loaded would register /codex-cu twice and keep the old guard on.
if printf '%s' "$LISTED" | grep -q "\"codex-computer-use@$MARKET\""; then
  say "plugin codex-computer-use: replaced by codex"
  act claude plugin uninstall "codex-computer-use@$MARKET" --scope user
fi
for p in $PLUGINS; do
  say "plugin $p"
  if printf '%s' "$LISTED" | grep -q "\"$p@$MARKET\""; then
    act claude plugin update "$p@$MARKET" --scope user
  else
    act claude plugin install "$p@$MARKET" --scope user
  fi
done

# The plugin's own folder holds its helper: the installer copies the code to ~/.claude/mcp and loads the LaunchAgent.
helper() {
  name=$1
  [ -x "$NODE" ] || { warn "$name helper skipped: $NODE is missing (install the ChatGPT desktop app)"; return 0; }
  if [ -n "$CHECK" ] && ! claude plugin list --json 2>/dev/null | grep -q "\"$name@$MARKET\""; then
    printf 'would: install the %s helper from the plugin once it is installed\n' "$name"
    return 0
  fi
  dir=$(claude plugin list --json 2>/dev/null |
    sed -n "s|.*\"installPath\": *\"\\([^\"]*/$MARKET/$name/[^\"]*\\)\".*|\\1|p" | head -1)
  [ -n "$dir" ] && [ -f "$dir/helper/install.sh" ] || fail "$name: no helper/install.sh in the installed plugin"
  say "helper $name"
  # The rest of the plugin works without it, so a helper that cannot install is a warning, not the end of the run.
  if [ -n "$CHECK" ]; then set -- --check; else set --; fi
  sh "$dir/helper/install.sh" "$@" || warn "$name helper not installed: computer use stays unavailable until $dir/helper/install.sh succeeds"
}

# Computer use, and so its helper, is macOS only.
if [ -n "$MAC" ]; then
  for p in $PLUGINS; do
    case "$p" in
      codex) helper codex ;;
    esac
  done
fi

printf '\ndone. Next:\n  - start a new Claude Code session, or run /reload-plugins\n'
for p in $PLUGINS; do
  case "$p" in
    codex) if [ -n "$MAC" ]; then echo '  - codex computer use: `/codex-cu on` turns it on, and `/codex-cu status` should report the helper running'; fi ;;
    coolify) echo '  - coolify needs its url and apiKey: `claude plugin configure coolify`' ;;
    subagent-effort) echo '  - subagent-effort needs a Jev key: its apiKey (`claude plugin configure subagent-effort`) or SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY (or JEV_API_KEY) in the environment' ;;
    gitlab) echo '  - gitlab needs its tokens (host=token pairs): `claude plugin configure gitlab`' ;;
    tailscale) echo '  - tailscale needs its apiKey: `claude plugin configure tailscale`' ;;
  esac
done
