#!/usr/bin/env bash
# Release-trigger helper. Run from repo root before pushing.
# Usage: ./.github/ci/tag.sh <version>   (e.g. 0.1.0)
# Set DRY_RUN=1 to run checks and skip tag/push mutations.
set -euo pipefail

cd "$(dirname "$0")/../.."

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version> (semver, e.g. 0.1.0)" >&2
  exit 1
fi

BOOKMARKS="$(jj bookmark list main)"
if [[ "$BOOKMARKS" != main:* ]]; then
  echo "Local main bookmark not found. Aborting." >&2
  exit 1
fi

STATUS="$(jj status)"
if [[ "$STATUS" != *"working copy has no changes"* ]]; then
  echo "Working copy not clean. Aborting." >&2
  exit 1
fi

TAG="v$VERSION"
TAGS="$(jj tag list)"
if [[ "$TAGS" =~ (^|[[:space:]])${TAG}([[:space:]]|$) ]]; then
  echo "Tag $TAG already exists. Aborting." >&2
  exit 1
fi

echo "==> running build checks"
npm ci
npx @biomejs/biome check .
npx vitest run

# Sync package.json into the release: the tagged commit must carry the
# version it names. npm bumps package.json + package-lock.json without
# touching VCS; the bump is committed on main as `chore: release vX.Y.Z`
# and the tag points at that commit.
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: npm version $VERSION --no-git-tag-version"
  echo "DRY_RUN: jj commit -m 'chore: release $TAG'"
  echo "DRY_RUN: jj bookmark set main -r @"
  echo "DRY_RUN: jj tag set $TAG -r @"
  echo "DRY_RUN: jj git push --bookmark main --tag $TAG"
else
  npm version "$VERSION" --no-git-tag-version
  jj commit -m "chore: release $TAG"
  jj bookmark set main -r @
  jj tag set "$TAG" -r @
  jj git push --bookmark main --tag "$TAG"
fi

echo "Done. The $TAG push triggers the release job."
