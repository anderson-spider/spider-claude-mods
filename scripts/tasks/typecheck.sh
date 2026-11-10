#!/usr/bin/env bash
# npm run typecheck [-- <name>] — run the pinned tsc on one plugin, or on every plugin with a tsconfig.json.
set -euo pipefail
. scripts/tasks/lib.sh
use_pinned_tools
name=${1:-}
typed_plugin_dirs ${name:+"$name"}
ensure_typings "${dirs[@]}"
failed=()
for d in "${dirs[@]}"; do
  echo "==> tsc ${d%/}"
  tsc -p "${d}tsconfig.json" || failed+=("${d%/}")
done
if [ "${#failed[@]}" -gt 0 ]; then echo "tsc failed: ${failed[*]}" >&2; exit 1; fi
