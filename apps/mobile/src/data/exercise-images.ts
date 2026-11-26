import type { ImageSourcePropType } from "react-native";
import backSquat from "../../media/exercises/back-squat.webp";
import barbellBenchPress from "../../media/exercises/barbell-bench-press.webp";
import barbellCurl from "../../media/exercises/barbell-curl.webp";
import barbellHipThrust from "../../media/exercises/barbell-hip-thrust.webp";
import barbellInclineBenchPressMediumGrip from "../../media/exercises/barbell-incline-bench-press-medium-grip.webp";
import barbellRow from "../../media/exercises/barbell-row.webp";
import bicepsCurl from "../../media/exercises/biceps-curl.webp";
import cableCrossover from "../../media/exercises/cable-crossover.webp";
import cableLateralRaise from "../../media/exercises/cable-lateral-raise.webp";
import chinUp from "../../media/exercises/chin-up.webp";
import closeGripBarbellBenchPress from "../../media/exercises/close-grip-barbell-bench-press.webp";
import crunches from "../../media/exercises/crunches.webp";
import deadlift from "../../media/exercises/deadlift.webp";
import dumbbellBenchPress from "../../media/exercises/dumbbell-bench-press.webp";
import dumbbellFlyes from "../../media/exercises/dumbbell-flyes.webp";
import dumbbellShoulderPress from "../../media/exercises/dumbbell-shoulder-press.webp";
import facePull from "../../media/exercises/face-pull.webp";
import gobletSquat from "../../media/exercises/goblet-squat.webp";
import hammerCurls from "../../media/exercises/hammer-curls.webp";
import hangingKneeRaise from "../../media/exercises/hanging-knee-raise.webp";
import inclineDumbbellPress from "../../media/exercises/incline-dumbbell-press.webp";
import lateralRaise from "../../media/exercises/lateral-raise.webp";
import legCurl from "../../media/exercises/leg-curl.webp";
import legExtensions from "../../media/exercises/leg-extensions.webp";
import legPress from "../../media/exercises/leg-press.webp";
import oneArmDumbbellRow from "../../media/exercises/one-arm-dumbbell-row.webp";
import overheadPress from "../../media/exercises/overhead-press.webp";
import parallelBarDip from "../../media/exercises/parallel-bar-dip.webp";
import preacherCurl from "../../media/exercises/preacher-curl.webp";
import pullUp from "../../media/exercises/pull-up.webp";
import pushups from "../../media/exercises/pushups.webp";
import romanianDeadlift from "../../media/exercises/romanian-deadlift.webp";
import seatedCableRows from "../../media/exercises/seated-cable-rows.webp";
import seatedLegCurl from "../../media/exercises/seated-leg-curl.webp";
import splitSquatWithDumbbells from "../../media/exercises/split-squat-with-dumbbells.webp";
import standingDumbbellCalfRaise from "../../media/exercises/standing-dumbbell-calf-raise.webp";
import standingDumbbellTricepsExtension from "../../media/exercises/standing-dumbbell-triceps-extension.webp";
import tricepsPushdown from "../../media/exercises/triceps-pushdown.webp";
import tricepsPushdownRopeAttachment from "../../media/exercises/triceps-pushdown-rope-attachment.webp";
import wideGripLatPulldown from "../../media/exercises/wide-grip-lat-pulldown.webp";

/**
 * The exercise images (media/exercises), by built-in exercise id. Metro bundles an image only
 * when code imports it by a literal path, so each one is listed here.
 */
const IMAGES: Readonly<Record<string, ImageSourcePropType>> = {
  "builtin:back-squat": backSquat,
  "builtin:barbell-bench-press": barbellBenchPress,
  "builtin:barbell-curl": barbellCurl,
  "builtin:barbell-hip-thrust": barbellHipThrust,
  "builtin:barbell-incline-bench-press-medium-grip": barbellInclineBenchPressMediumGrip,
  "builtin:barbell-row": barbellRow,
  "builtin:biceps-curl": bicepsCurl,
  "builtin:cable-crossover": cableCrossover,
  "builtin:cable-lateral-raise": cableLateralRaise,
  "builtin:chin-up": chinUp,
  "builtin:close-grip-barbell-bench-press": closeGripBarbellBenchPress,
  "builtin:crunches": crunches,
  "builtin:deadlift": deadlift,
  "builtin:dumbbell-bench-press": dumbbellBenchPress,
  "builtin:dumbbell-flyes": dumbbellFlyes,
  "builtin:dumbbell-shoulder-press": dumbbellShoulderPress,
  "builtin:face-pull": facePull,
  "builtin:goblet-squat": gobletSquat,
  "builtin:hammer-curls": hammerCurls,
  "builtin:hanging-knee-raise": hangingKneeRaise,
  "builtin:incline-dumbbell-press": inclineDumbbellPress,
  "builtin:lateral-raise": lateralRaise,
  "builtin:leg-curl": legCurl,
  "builtin:leg-extensions": legExtensions,
  "builtin:leg-press": legPress,
  "builtin:one-arm-dumbbell-row": oneArmDumbbellRow,
  "builtin:overhead-press": overheadPress,
  "builtin:parallel-bar-dip": parallelBarDip,
  "builtin:preacher-curl": preacherCurl,
  "builtin:pull-up": pullUp,
  "builtin:pushups": pushups,
  "builtin:romanian-deadlift": romanianDeadlift,
  "builtin:seated-cable-rows": seatedCableRows,
  "builtin:seated-leg-curl": seatedLegCurl,
  "builtin:split-squat-with-dumbbells": splitSquatWithDumbbells,
  "builtin:standing-dumbbell-calf-raise": standingDumbbellCalfRaise,
  "builtin:standing-dumbbell-triceps-extension": standingDumbbellTricepsExtension,
  "builtin:triceps-pushdown-rope-attachment": tricepsPushdownRopeAttachment,
  "builtin:triceps-pushdown": tricepsPushdown,
  "builtin:wide-grip-lat-pulldown": wideGripLatPulldown,
};

/** The exercise's image, or null when it has none (most exercises, and every custom one). */
export function exerciseImage(id: string): ImageSourcePropType | null {
  return Object.hasOwn(IMAGES, id) ? (IMAGES[id] ?? null) : null;
}
