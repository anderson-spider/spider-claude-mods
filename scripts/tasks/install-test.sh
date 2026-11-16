#!/usr/bin/env bash
# bash scripts/tasks/install-test.sh — install the marketplace from this checkout on a clean Linux machine (a Docker image), as a
# new user would, and check that every plugin is installed and loads. Needs Docker; no login and no network once built.
set -euo pipefail
image=claude-mods-install-test
build=()
# Where the host reaches the network through a proxy and a CA of its own, as a Claude Code cloud session does, the build
# shares the host's network and proxy settings and trusts that CA (NODE_EXTRA_CA_CERTS), which the image does not keep.
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  build+=(--network host --secret "id=ca,src=$NODE_EXTRA_CA_CERTS")
  for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do [ -n "${!v:-}" ] && build+=(--build-arg "$v"); done
fi
docker build --quiet "${build[@]}" -f scripts/install-test/Dockerfile -t "$image" . >/dev/null
docker run --rm "$image"
