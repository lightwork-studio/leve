#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:?Pass the release tag.}"
mode="${2:?Pass build or ota.}"
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a vMAJOR.MINOR.PATCH release tag.' >&2
  exit 1
fi
if [ "$mode" != build ] && [ "$mode" != ota ]; then
  echo 'Expected build or ota.' >&2
  exit 1
fi

tag_commit="$(git rev-parse --verify "refs/tags/$tag^{commit}")"
commit="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$tag_commit" "$commit" ||
  ! git merge-base --is-ancestor "$commit" origin/main ||
  { [ "$mode" = build ] && [ "$commit" != "$tag_commit" ]; }; then
  echo 'Release must use a main commit and the store build must match its release tag.' >&2
  exit 1
fi

: "${LEVE_PRODUCTION_EAS_PROJECT_ID:?Configure the production EAS project ID.}"
: "${EXPO_TOKEN:?Configure the production EAS token.}"
export LEVE_APP_VARIANT=production LEVE_STORE_VERSION="${tag#v}"
export EXPO_PUBLIC_BUILD_LABEL='App Store' EXPO_PUBLIC_SAMPLE_DATA=off
export EXPO_PUBLIC_COMMIT="${commit:0:7}"
export EXPO_PUBLIC_RELEASE_NUMBER="$(git rev-list --first-parent --count HEAD)"

eas() { npx --yes eas-cli@27.11.0 "$@"; }

if [ "$mode" = ota ]; then
  runtime="$(eas env:exec production \
    'EXPO_NO_DOTENV=1 pnpm exec expo-updates runtimeversion:resolve --platform ios --workflow managed' \
    --non-interactive |
    node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8")).runtimeVersion ?? "")')"
  : "${runtime:?Could not resolve the production runtime.}"
  usable="$(eas build:list --platform ios --channel production --runtime-version "$runtime" \
    --distribution store --app-version "$LEVE_STORE_VERSION" --git-commit-hash "$tag_commit" \
    --limit 50 --json --non-interactive |
    node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8")).some(build => build.status === "FINISHED"))')"
  if [ "$usable" != true ]; then
    echo 'No finished EAS build from the release tag matches this runtime. Make a store build first.' >&2
    exit 1
  fi
  eas update --channel production --platform ios --environment production --message "$tag" --non-interactive
  exit 0
fi

: "${ASC_API_KEY_PATH:?Configure the production App Store Connect API key.}"
: "${ASC_API_KEY_ID:?Configure the production App Store Connect key ID.}"
: "${ASC_API_ISSUER_ID:?Configure the production App Store Connect issuer ID.}"
: "${LEVE_PRODUCTION_ASC_APP_ID:?Configure the production App Store Connect app ID.}"
: "${LEVE_PRODUCTION_APPLE_TEAM_ID:?Configure the production Apple team ID.}"

backup="$(mktemp)"
cp eas.json "$backup"
trap 'cp "$backup" eas.json; rm -f "$backup"' EXIT
node <<'NODE'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("eas.json", "utf8"));
for (const name of ["LEVE_STORE_VERSION", "LEVE_PRODUCTION_EAS_PROJECT_ID", "LEVE_EXPO_OWNER", "EXPO_PUBLIC_COMMIT", "EXPO_PUBLIC_RELEASE_NUMBER"]) {
  if (process.env[name]) config.build.production.env[name] = process.env[name];
}
config.submit.production = { ios: {
  ascAppId: process.env.LEVE_PRODUCTION_ASC_APP_ID,
  appleTeamId: process.env.LEVE_PRODUCTION_APPLE_TEAM_ID,
  ascApiKeyPath: process.env.ASC_API_KEY_PATH,
  ascApiKeyId: process.env.ASC_API_KEY_ID,
  ascApiKeyIssuerId: process.env.ASC_API_ISSUER_ID,
} };
fs.writeFileSync("eas.json", JSON.stringify(config, null, 2) + "\n");
NODE
eas build --platform ios --profile production --auto-submit --non-interactive --no-wait --message "$tag"
