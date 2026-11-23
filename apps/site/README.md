# Leve landing page

Run `pnpm build:site` from the repository root. Serve `apps/site/dist/` from any static host.
The output is self-contained and can also be opened locally from `apps/site/dist/index.html`.

The build copies the Leve brand assets and the app screens in `shots/`, and generates CSS
variables from the mobile app’s palette and browser font stacks. The screens were captured from
the Expo web build with sample data, in a 390 × 844 viewport at 2× in dark appearance.

When deployment is enabled, the Release workflow publishes the page to Cloudflare Pages on pushes
to `main`. See [the Release workflow](../../.github/workflows/release.yml) for the environment and credentials.
