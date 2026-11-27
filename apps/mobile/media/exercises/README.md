# Exercise images

One still per exercise, showing a key position of the movement on its equipment. There are 80 so
far, chosen from common gym exercises and added in groups of 40. The app shows an exercise's image
at the top of its screen and of its sheet in the current workout, and a small square crop of it (in
`thumbs/`) beside its name in the exercise picker, the Exercises list, the current workout and the
routine editor. Exercises without one keep the body figure, or their number in the workout and
routine editor.

- **Names:** each file is named after the built-in exercise it shows, without the `builtin:`
  prefix: `barbell-bench-press.webp` is `builtin:barbell-bench-press`. A new image also needs its
  line in [`src/data/exercise-images.ts`](../../src/data/exercise-images.ts), which the app
  bundles the images from.
- **Highlights** show the exercise's muscles as the catalog lists them: primary muscles in burnt
  orange, secondary muscles in a lighter orange, and nothing else. The primary material colour is
  `#B73F22`; the studio lighting makes it look brighter in the renders. Within a listed group,
  only the parts the exercise works are coloured, such as the front deltoid for "Shoulders" on
  the bench press, or the front and side deltoids on overhead presses. Where the catalog lists
  "Full body" as the primary muscle, as on the kettlebell swing, only the secondary muscles are
  coloured. "Abductors" colours the gluteus medius and the muscle along the outer hip
  (tensor fasciae latae).
- **Camera:** each exercise is seen from the side where its primary muscles show, so most back
  exercises are shown from behind. Where a seat or bench hides a muscle, as on the seated leg
  curl, only the visible part is coloured.
- **Thumbnails:** `thumbs/` has a 144 × 144 WebP of each image with the same name, for 48 points
  on screen. Each frames the whole person, centred with the same margin, so the exercise reads at
  that size and every thumbnail matches in scale. Every image needs its thumbnail.
- **Format:** 1024 × 1024 WebP (quality 90) on a warm off-white `#F4F0E7`, between the paper
  palette's ground (`#EEEBE4`) and its cards (`#F8F6F1`). There is no dark version yet.
- **Equipment:** the goblet squat is shown with a dumbbell, although the catalog lists a
  kettlebell.
- **How they are made:** rendered in Blender (Cycles). The figure is posed on a rig made for Leve,
  with grips, foot contacts and pad contacts placed on the equipment. Every pose is measured for
  limbs passing into the body or the equipment before it is rendered. The Blender scenes aren't
  in this repository, because the anatomy model can't be shared, so new or changed images come
  from the maintainers.

[`apps/mobile/test/exercise-images.test.ts`](../../test/exercise-images.test.ts) checks the names,
the thumbnails and that list against the catalog. The images use the
[Leve exercise image terms](../../../../LICENSES/LicenseRef-Leve-Exercise-Images.txt); see the
[third-party notices](../../../../THIRD_PARTY_NOTICES.md) for the figure's credit.
