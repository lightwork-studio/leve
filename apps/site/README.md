# Leve landing page

Run `pnpm build:site` from the repository root to export the Expo web demo and package it alongside
the landing page in `apps/site/dist/`. Serve that directory from the root of an HTTPS static host
or from localhost. The landing page can also be opened from disk, where it shows the screenshots.

The hero phone loads the real app only after visitors click **Try the live demo**. The demo starts
with sample workouts and keeps changes in memory for the life of the frame. On hosts other than
Cloudflare Pages, configure the equivalent of `_redirects` to support refreshing app routes.

`privacy.html`, `support.html` and `impressum.html` hold the privacy policy, support page and legal
notice. App Store Connect links to the first two, so keep their paths stable, and update the privacy
policy when the app or sync server starts handling data differently. Every page links to all three
in its footer.

The build copies the Leve brand assets and the app screens in `shots/`, and generates CSS
variables from the mobile app’s palette and browser font stacks. The screens were captured from
the Expo web build with sample data, in a 390 × 844 viewport at 2× in dark appearance.

When deployment is enabled, the Release workflow publishes the page to Cloudflare Pages on pushes
to `main`. The deployed page links to the source and notices for that revision and includes the
license shipped with sql.js. See [the Release workflow](../../.github/workflows/release.yml) for the environment
and credentials.
