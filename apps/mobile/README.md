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

Local builds use the name Leve Dev and bundle ID `app.leve.dev`. They run with sample data and
OTA updates disabled, independently of the official Leve Preview build (`app.leve.preview`).
The official release workflow selects the Preview configuration explicitly. If you distribute a
fork, configure its own bundle ID and scheme and follow the [branding terms](../../TRADEMARKS.md).

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
