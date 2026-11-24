# Leve app

The Expo app includes workout logging, routines, workout notes, history, and progress charts.
Development builds start with sample data.

```sh
pnpm dev:app       # Expo dev server (Expo Go, simulators, or the web on localhost)
pnpm preview:web   # export the web build and serve it on 127.0.0.1:41788
```

Expo generates the local `ios/` and `android/` projects from the app configuration and native
dependencies. Keep native changes in the config, modules, or patches so a clean checkout can build
them. The generated projects and bundle exports are ignored by Git.

`LEVE_WEB_PORT` and `LEVE_WEB_DIR` change the port and the build the web preview serves. It only
listens on loopback (`LEVE_WEB_HOST` accepts loopback addresses only). To open it on a phone, put it behind a private HTTPS proxy you control
rather than exposing it on a network. `EXPO_PUBLIC_COMMIT` and `EXPO_PUBLIC_BUILD_LABEL`, set at
export time, are shown in the app so you can tell which build is running. A new install starts with made-up
sample data, which the reset in Settings brings back. `EXPO_PUBLIC_SAMPLE_DATA=off` turns that off,
so the app starts empty and the reset deletes everything; TestFlight builds and their updates set it.

## App identities

| App          | iOS bundle ID         | Delivery                                      |
| ------------ | --------------------- | --------------------------------------------- |
| Leve Dev     | `app.leve.dev`        | Local development with sample workouts        |
| Leve Preview | `app.leve.preview`    | TestFlight and the `preview` update channel   |
| Leve         | `app.leve.production` | App Store and the `production` update channel |

The apps have separate device storage. Local development uses Leve Dev with OTA updates off.
To share a native development build, set `LEVE_DEV_EAS_PROJECT_ID` to a separate Expo project
in both your shell and that project's EAS `development` environment. Set `LEVE_EXPO_OWNER`
in both places if the project uses a different Expo owner. Run `eas build --profile development`
from this directory. If you distribute a fork, configure its own bundle ID and scheme and follow
the [branding terms](../../TRADEMARKS.md).

Use `pnpm preview:web` to try a branch locally with sample workouts. When enabled by maintainers,
the **Branch web preview** workflow builds the requested PR commit with sample workouts and
links to its exact deployment in the run summary. Before enabling the workflow, set up a
dedicated Pages project with `main` as its production branch in a separate Cloudflare account.
Keep the deployment token in the `branch-web-preview` GitHub environment, restrict the
environment to `main`, and require approval from a reviewer who has checked the selected PR.

## TestFlight

The TestFlight preview is for disposable test data. Its storage format may change and preview
workouts may need to be reset. See the [data preservation promise](../../docs/data-compatibility.md#data-preservation-promise).

When deployment is enabled, every push to `main` runs the checks and then `scripts/deploy-ios.sh`.

- If an existing build has the same runtime version, the change is published as an over-the-air
  update to the `preview` channel. The installed app downloads it on launch and runs it on the
  next launch.
- If the native layer changed (new native module, app config change), there is no matching build
  yet, so a new build starts on EAS and is uploaded to TestFlight when it finishes.

The runtime version is a fingerprint of the native layer, so nobody has to decide which path a
change needs. To force a new build, run the Release workflow manually on `main` with "build" set.

The release number adds a fixed offset to the count of commits on `main`'s first-parent history.
Each merge adds one, and retrying the same commit keeps its number. Compare the **release** at the
bottom of Settings with the release in the EAS update or build message. A match means that release
is running on your phone. The app version can stay at `0.1.0` across multiple releases.

The TestFlight environment needs `EXPO_TOKEN`, `ASC_API_KEY_P8` (the App Store Connect API key
file's contents), `ASC_API_KEY_ID` and `ASC_API_ISSUER_ID`. Signing certificates and profiles are
kept on EAS.

CI does not wait for a build: a failed build or TestFlight upload shows up on expo.dev and in
email, not as a red CI run. Later JavaScript pushes still go out as updates to that build, so after
such a failure run the workflow manually with "build" set (or resubmit the build with `eas submit`).

## App Store

When App Store publishing is enabled, pushing a version tag such as `v1.0.0` starts a release
request. The **App Store** workflow on `main` verifies that the tag points to the final commit
of a merged pull request on `main` before starting a build. Protect release tags against moves
and deletions before enabling publishing.

Keep Apple and Expo production credentials in the `app-store` GitHub environment. Restrict
that environment to the `main` branch, require a separate reviewer, and disable administrator
bypass. Set the environment variable `LEVE_APPROVED_STORE_TAG` in GitHub to the tag of the live
version and build after confirming it in App Store Connect. For an OTA fix, dispatch the workflow
from `main` with that tag and the final commit of the merged fix. EAS checks that the fix matches
the tagged build's native runtime. Use a new store build for native changes and changes that
require App Review.

Keep release-specific values such as `LEVE_STORE_VERSION`, `LEVE_APP_VARIANT` and
`EXPO_PUBLIC_RELEASE_NUMBER` in the release script or build profile so that EAS environment
variables cannot override them during OTA publishing.
