#!/usr/bin/env bash
# predeploy-check.sh <running-image> <candidate-image> [path-in-image]
#
# Answers the question I failed to ask before deploying over a hotfix that
# existed only in the running image: does the candidate REMOVE anything
# production currently has? A normal diff shows churn in both directions and
# buries that; this reports it directly.
set -euo pipefail
RUNNING="${1:?running image}"; CANDIDATE="${2:?candidate image}"; SUBPATH="${3:-/app/backend}"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
for tag in running candidate; do
  img=$([ "$tag" = running ] && echo "$RUNNING" || echo "$CANDIDATE")
  cid=$(docker create "$img"); docker cp "$cid:$SUBPATH" "$work/$tag" >/dev/null; docker rm -f "$cid" >/dev/null
done
echo "running   : $RUNNING"
echo "candidate : $CANDIDATE"
echo
missing=0
while IFS= read -r f; do
  rel="${f#$work/running/}"
  if [ ! -e "$work/candidate/$rel" ]; then
    echo "REMOVED FILE: $rel"; missing=1; continue
  fi
  if ! cmp -s "$f" "$work/candidate/$rel"; then
    only_running=$(diff "$f" "$work/candidate/$rel" | grep -c '^<' || true)
    only_cand=$(diff "$f" "$work/candidate/$rel" | grep -c '^>' || true)
    printf 'CHANGED: %-55s running-only=%-4s candidate-only=%s\n' "$rel" "$only_running" "$only_cand"
    [ "$only_running" -gt 0 ] && missing=1
  fi
done < <(find "$work/running" -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) ! -path '*__pycache__*' ! -path '*node_modules*' | sort)
echo
scanned=$(find "$work/running" -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) ! -path '*__pycache__*' ! -path '*node_modules*' | wc -l)
echo "files compared: $scanned"
if [ "$scanned" -eq 0 ]; then
  echo "NOTHING COMPARED — wrong path-in-image? A zero-file scan is not a pass."
  exit 2
fi
if [ "$missing" -eq 0 ]; then
  echo "OK — the candidate drops nothing the running image has."
else
  echo "REVIEW REQUIRED — lines above marked running-only>0 exist in production"
  echo "and not in the candidate. Confirm each is intentional before deploying."
fi
