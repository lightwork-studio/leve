#!/usr/bin/env bash
# Ships the iOS preview to TestFlight testers.
#
# A JavaScript-only change is published as an over-the-air update to the installed build. When the
# native layer has changed (its fingerprint, which is also the app's runtime version, has no build
# yet), a new build is started instead and uploaded to TestFlight once it finishes.
#
# Needs EXPO_TOKEN. A build also needs ASC_API_KEY_PATH (a .p8 file outside the project, so it is
# never uploaded with the source), ASC_API_KEY_ID and ASC_API_ISSUER_ID.
# Set FORCE_BUILD=true to build even when a compatible build exists. Builds run only in CI, whose
# fresh checkout holds nothing but committed files: EAS uploads the working tree.
set -euo pipefail

cd "$(dirname "$0")/.."

EAS_CLI="eas-cli@27.11.0"
eas() { npx --yes "$EAS_CLI" "$@"; }

commit="${COMMIT:-$(git rev-parse --short HEAD)}"
subject="$(git log -1 --format=%s)"
# An update must be bundled with the same build settings as the binaries it reaches.
# Read first, so a broken eas.json stops the deploy instead of shipping without those settings.
build_env="$(node -e '
  for (const [key, value] of Object.entries(require("./eas.json").build.preview.env))
    console.log(key + "=" + value)')"
while IFS= read -r line; do export "$line"; done <<<"$build_env"

# Checks finish in any order, and old runs can be re-run: only the branch's newest commit ships,
# so an older bundle never replaces a newer one on testers' phones.
if [ -n "${GITHUB_REF:-}" ] && [ -n "${GITHUB_SHA:-}" ]; then
  tip="$(git ls-remote origin "$GITHUB_REF" | cut -f1)"
  if [ "$tip" != "$GITHUB_SHA" ]; then
    echo "$GITHUB_SHA is no longer the tip of $GITHUB_REF ($tip); skipping."
    exit 0
  fi
fi

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "Release numbering needs full Git history. Run git fetch --unshallow." >&2
  exit 1
fi
release_base="${LEVE_RELEASE_BASE:-0}"
if [[ ! "$release_base" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
  echo "LEVE_RELEASE_BASE must be a non-negative decimal number with at most nine digits." >&2
  exit 1
fi
commit_count="$(git rev-list --first-parent --count HEAD)"
release="$((release_base + commit_count))"
message="Release $release ($commit) $subject"

runtime="$(npx expo-updates runtimeversion:resolve --platform ios |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runtimeVersion))')"
if [ -z "$runtime" ]; then
  echo "Could not resolve the iOS runtime version." >&2
  exit 1
fi
echo "Release $release, commit $commit, iOS runtime version $runtime"

# A build that is queued or running counts too: an update published now reaches it once installed.
usable_builds=0
if [ "${FORCE_BUILD:-false}" != "true" ]; then
  usable_builds="$(eas build:list --platform ios --channel preview --runtime-version "$runtime" \
    --limit 50 --json --non-interactive |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const ok=new Set(["NEW","IN_QUEUE","IN_PROGRESS","FINISHED"]);
      console.log(JSON.parse(s||"[]").filter(b=>ok.has(b.status)).length)})')"
fi

if [ "$usable_builds" -gt 0 ]; then
  echo "A build for this runtime exists; publishing an update."
  EXPO_PUBLIC_COMMIT="$commit" EXPO_PUBLIC_RELEASE_NUMBER="$release" \
    eas update --channel preview --platform ios --environment preview \
    --message "$message" --non-interactive
  exit 0
fi

if [ "${CI:-}" != "true" ]; then
  echo "A new build is needed; builds run from CI only." >&2
  exit 1
fi
: "${ASC_API_KEY_PATH:?A new build needs ASC_API_KEY_PATH}"
: "${ASC_API_KEY_ID:?A new build needs ASC_API_KEY_ID}"
: "${ASC_API_ISSUER_ID:?A new build needs ASC_API_ISSUER_ID}"

echo "No build for this runtime yet; starting a build that is uploaded to TestFlight."
# The release, commit, and submission key are added to eas.json for this run only.
backup="$(mktemp)"
cp eas.json "$backup"
trap 'cp "$backup" eas.json; rm -f "$backup"' EXIT
COMMIT="$commit" RELEASE_NUMBER="$release" node -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync("eas.json", "utf8"));
  config.build.preview.env = {
    ...config.build.preview.env,
    EXPO_PUBLIC_COMMIT: process.env.COMMIT,
    EXPO_PUBLIC_RELEASE_NUMBER: process.env.RELEASE_NUMBER,
  };
  config.submit.preview.ios = {
    ...config.submit.preview.ios,
    ascApiKeyPath: process.env.ASC_API_KEY_PATH,
    ascApiKeyId: process.env.ASC_API_KEY_ID,
    ascApiKeyIssuerId: process.env.ASC_API_ISSUER_ID,
  };
  fs.writeFileSync("eas.json", JSON.stringify(config, null, 2) + "\n");
'
eas build --platform ios --profile preview --auto-submit --non-interactive --no-wait \
  --message "$message"
