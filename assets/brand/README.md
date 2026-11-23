# Leve brand assets

The logo is the word **Leve** with a full stop in vermilion, set in JetBrains Mono ExtraBold. The app
icon is the same thing cut down to **L.** Every file here is outlined, so nothing depends on a font
being installed.

| File                                          | Use                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `wordmark-on-dark.svg`, `wordmark-on-light.svg` | The full logo on graphite or paper grounds.                          |
| `mark-on-dark.svg`, `mark-on-light.svg`       | The **L.** mark alone, trimmed to its bounds.                          |
| `icon.svg`, `icon-light.svg`                  | Rounded app tiles for docs and the web (`../icon.svg` is `icon.svg`).  |
| `png/icon.png`                                | App icon, 1024 px, opaque RGB with square corners (the OS rounds them). |
| `png/android-icon-*.png`                      | Android adaptive icon layers; the mark sits inside the safe zone.      |
| `png/favicon.png`                             | Web favicon, 48 px.                                                    |
| `png/splash-icon-on-dark.png`, `-on-light.png` | Transparent splash mark for a graphite or paper splash colour.        |

The PNGs use the file names in `apps/mobile/assets`, so they can be copied over directly. With these
icons, set the Android adaptive icon's `backgroundColor` in `app.json` to graphite, `#101217`.

## Colours

These match the app's palettes in `apps/mobile/src/theme.ts`.

| Role        | Dark (graphite) | Light (paper) |
| ----------- | --------------- | ------------- |
| Ground      | `#101217`       | `#EEEBE4`     |
| Ink         | `#F3F1EC`       | `#15171C`     |
| Full stop   | `#FF5A2C`       | `#F24E1E`     |

Keep the full stop vermilion and the word in a single ink. A monospace font leaves a wide gap before
the full stop, so the logo closes it to about one stem width. Don't retype the logo in a font; use
these files.

## Rebuilding

`generate.mjs` writes every file here from the font. Install its dependencies outside the repo and
pass that folder:

```sh
npm i --prefix /tmp/leve-brand --ignore-scripts opentype.js@1.3.4 @resvg/resvg-js@2.6.2 @fontsource/jetbrains-mono@5.3.0
node assets/brand/generate.mjs /tmp/leve-brand
```

JetBrains Mono is licensed under the SIL Open Font License 1.1, which allows using its outlines in a
logo.
