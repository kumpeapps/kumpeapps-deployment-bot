#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:-}"
output_path="${2:-}"

if [[ -z "$release_tag" ]]; then
  echo "Usage: $0 <release-tag> [output-file]"
  exit 1
fi

if [[ -z "$output_path" ]]; then
  output_path="docs/releases/${release_tag}.md"
fi

mkdir -p "$(dirname "$output_path")"

if git rev-parse "$release_tag" >/dev/null 2>&1; then
  target_ref="$release_tag"
else
  target_ref="HEAD"
fi

previous_tag="$(git tag --sort=-creatordate | grep -Fxv "$release_tag" | head -n 1 || true)"
if [[ -z "$previous_tag" ]]; then
  previous_tag="(none)"
fi

if [[ "$previous_tag" == "(none)" ]]; then
  changelog="$(git --no-pager log --oneline "$target_ref" | sed 's/^/- /')"
else
  changelog="$(git --no-pager log --oneline "${previous_tag}..${target_ref}" | sed 's/^/- /')"
fi

if [[ -z "$changelog" ]]; then
  changelog="- No commits in selected range"
fi

date_value="$(date -u +"%Y-%m-%d")"

cat > "$output_path" <<EOF
# Release Notes: ${release_tag}

Date: ${date_value}
Previous Tag: ${previous_tag}
Commit Range: ${previous_tag}..${release_tag}

## Summary

- 

## Key Features

- 

## Migrations

- 

## Environment Changes

Added:

- 

Changed:

- 

Removed:

- 

## Operational Notes

- 

## Known Risks

- 

## Verification Evidence

- Build:
- Tests:
- Smoke:

## Changelog (Auto)

${changelog}
EOF

echo "Generated ${output_path}"
