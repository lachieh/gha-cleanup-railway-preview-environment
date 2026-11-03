#!/usr/bin/env bash
set -euo pipefail

[[ "${PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]] || { echo "::error::pr-number must be a positive integer, got '${PR_NUMBER:-}'."; exit 1; }

project="${RAILWAY_PROJECT:-}"
dry_run="${DRY_RUN:-false}"

listing=$(gh api "repos/$REPOSITORY/environments" --paginate -q '.environments[].name')
pattern="^[^/]+ / ([a-z0-9-]+-pr|pr-[0-9a-f]+)-${PR_NUMBER}\$"
matched=$(grep -E "$pattern" <<< "$listing" || true)

names=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ -n "$project" ] && [[ "$name" != "$project / "* ]]; then
    continue
  fi
  names+="$name"$'\n'
done <<< "$matched"

deleted=""
failed=0
if [ -z "$names" ]; then
  echo "No environments for pull request #$PR_NUMBER."
else
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ "$dry_run" = "true" ]; then
      echo "Would delete $name"
    elif response=$(gh api -X DELETE "repos/$REPOSITORY/environments/$(jq -rn --arg n "$name" '$n|@uri')" 2>&1); then
      echo "Deleted $name"
    elif grep -q 'HTTP 404' <<< "$response"; then
      echo "Already deleted $name"
    else
      echo "::error::Could not delete $name: $response"
      failed=1
      continue
    fi
    deleted+="$name"$'\n'
  done <<< "$names"
fi

{ echo 'deleted<<EOF'; printf '%s' "$deleted"; echo 'EOF'; } >> "$GITHUB_OUTPUT"
exit "$failed"
