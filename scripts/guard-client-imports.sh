#!/usr/bin/env bash
# Forbid server-only packages from being imported anywhere under client/.
# Prevents accidentally bundling secrets-handling SDKs into the browser.
#
# Run as part of CI / pre-build:
#   bash scripts/guard-client-imports.sh
#
# Add new entries to FORBIDDEN as needed.
set -euo pipefail

FORBIDDEN=(
  "livekit-server-sdk"
  "@livekit/protocol"
  "vaultClient"
  "drizzle-orm"   # client should never speak directly to the DB
  "pg"
)

fail=0
for pkg in "${FORBIDDEN[@]}"; do
  # Match `from "<pkg>"` or `from '<pkg>'` or `require("<pkg>")` under client/
  if hits=$(grep -RIn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
       -E "from ['\"]${pkg}['\"]|require\\(['\"]${pkg}['\"]\\)" client/ 2>/dev/null); then
    echo "FORBIDDEN client import of '${pkg}':"
    echo "$hits"
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo
  echo "Server-only modules must not be imported from client/. They will leak into the browser bundle."
  exit 1
fi

echo "client-import guard: OK"
