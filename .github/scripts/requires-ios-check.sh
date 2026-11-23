#!/usr/bin/env bash
set -euo pipefail

# Compare the exact PR base with the merge checkout that CI is testing.
if git diff --quiet --no-ext-diff "$1" HEAD -- \
  .github/workflows/ci.yml .github/workflows/workout-activity.yml .github/scripts/requires-ios-check.sh \
  .gitignore .node-version .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml patches \
  ':(glob)packages/**/package.json' \
  apps/mobile/app.json 'apps/mobile/app.config.*' apps/mobile/eas.json apps/mobile/assets \
  apps/mobile/package.json apps/mobile/metro.config.js apps/mobile/react-native.config.js \
  apps/mobile/plugins apps/mobile/modules \
  apps/mobile/ios apps/mobile/src/activity apps/mobile/test/ios; then
  printf 'false\n'
else
  status=$?
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
  printf 'true\n'
fi
