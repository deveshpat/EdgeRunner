#!/usr/bin/env bash
# Upload a directory of .whl files to the EdgeRunner GitHub release tag wheels-v1.
#
# Usage:
#   ./scripts/publish_wheels.sh ./wheel_dir
#   ./scripts/publish_wheels.sh ./wheel_dir deveshpat/EdgeRunner
set -euo pipefail

DIR="${1:-}"
REPO="${2:-deveshpat/EdgeRunner}"
TAG="wheels-v1"

if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "Usage: $0 <wheel_directory> [owner/repo]" >&2
  exit 1
fi

if ! command -v gh >/dev/null; then
  echo "gh CLI required" >&2
  exit 1
fi

shopt -s nullglob
WHEELS=("$DIR"/*.whl)
if [[ ${#WHEELS[@]} -eq 0 ]]; then
  echo "No .whl files in $DIR" >&2
  exit 1
fi

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" \
    --repo "$REPO" \
    --title "Prebuilt wheels (Kaggle fast install)" \
    --notes "Linux x86_64 wheels for EdgeRunner Kaggle workers. Installed automatically by bootstrap.py."
fi

gh release upload "$TAG" "${WHEELS[@]}" --repo "$REPO" --clobber
echo "Uploaded ${#WHEELS[@]} wheels to $REPO@$TAG"
