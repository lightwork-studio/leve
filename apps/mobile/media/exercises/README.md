# Exercise images

One still per exercise, showing a key position of the movement on its equipment. These are the
first 40, chosen from the most common gym exercises. They aren't shown in the app yet.

- **Names:** each file is named after the built-in exercise it shows, without the `builtin:`
  prefix: `barbell-bench-press.webp` is `builtin:barbell-bench-press`.
- **Highlights** show the exercise's muscles as the catalog lists them: primary muscles in burnt
  orange, secondary muscles in a lighter orange, and nothing else. The primary material colour is
  `#B73F22`; the studio lighting makes it look brighter in the renders. Within a listed group,
  only the parts the exercise works are coloured, such as the front deltoid for "Shoulders" on
  the bench press.
- **Camera:** each exercise is seen from the side where its primary muscles show, so most back
  exercises are shown from behind. Where a seat or bench hides a muscle, as on the seated leg
  curl, only the visible part is coloured.
- **Format:** 1024 × 1024 WebP (quality 90) on a warm off-white `#F4F0E7`, between the paper
  palette's ground (`#EEEBE4`) and its cards (`#F8F6F1`). There is no dark version yet.
- **Equipment:** the goblet squat is shown with a dumbbell, although the catalog lists a
  kettlebell.
- **How they are made:** rendered in Blender (Cycles). The figure is posed on a rig made for Leve,
  with grips, foot contacts and pad contacts placed on the equipment. Every pose is measured for
  limbs passing into the body or the equipment before it is rendered. The Blender scenes aren't
  in this repository, because the anatomy model can't be shared, so new or changed images come
  from the maintainers.

[`apps/mobile/test/exercise-images.test.ts`](../../test/exercise-images.test.ts) checks the names
against the catalog. The images use the
[Leve exercise image terms](../../../../LICENSES/LicenseRef-Leve-Exercise-Images.txt); see the
[third-party notices](../../../../THIRD_PARTY_NOTICES.md) for the figure's credit.
