#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment (paste it into the
# environment's "Setup script" field). Runs as root on the Ubuntu image before
# Claude Code starts, and the result is cached between sessions.
#
# Installs the Node version from .nvmrc (24) and runs `npm ci`, so
# `npm run check` works in a new session. The pinned Claude Code CLI comes
# from `npm ci`. Needs outbound access to nodejs.org and the npm registry
# (the "Trusted" network policy allows both).
set -euo pipefail

REPO_URL="https://github.com/anderson-spider/spider-claude-mods.git"
NODE_MAJOR="24"
NODE_DIR="/opt/node${NODE_MAJOR}"

# The repository is normally cloned already; clone it only if it is not.
REPO_DIR="$(find /home /workspace /root -maxdepth 3 -name .nvmrc -path '*spider-claude-mods*' -printf '%h\n' 2>/dev/null | head -n1 || true)"
if [ -z "$REPO_DIR" ]; then
  REPO_DIR="/home/user/spider-claude-mods"
  git clone --depth 50 "$REPO_URL" "$REPO_DIR"
fi

if [ ! -x "$NODE_DIR/bin/node" ]; then
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-${arch}.tar.xz" '$2 ~ a {print $2}')"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/$file" -o "$tmp/$file"
  curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" > "$tmp/sum"
  (cd "$tmp" && sha256sum -c sum)
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
fi

# Put Node 24 ahead of the image's Node on every shell.
for bin in node npm npx corepack; do
  ln -sf "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"
done
export PATH="$NODE_DIR/bin:$PATH"

cd "$REPO_DIR"
node -v
npm ci --no-audit --no-fund
