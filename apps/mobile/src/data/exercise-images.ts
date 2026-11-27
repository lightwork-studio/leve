import type { ImageSourcePropType } from "react-native";
import abRoller from "../../media/exercises/ab-roller.webp";
import arnoldDumbbellPress from "../../media/exercises/arnold-dumbbell-press.webp";
import backSquat from "../../media/exercises/back-squat.webp";
import barbellBenchPress from "../../media/exercises/barbell-bench-press.webp";
import barbellCurl from "../../media/exercises/barbell-curl.webp";
import barbellGluteBridge from "../../media/exercises/barbell-glute-bridge.webp";
import barbellHipThrust from "../../media/exercises/barbell-hip-thrust.webp";
import barbellInclineBenchPressMediumGrip from "../../media/exercises/barbell-incline-bench-press-medium-grip.webp";
import barbellRow from "../../media/exercises/barbell-row.webp";
import barbellShrug from "../../media/exercises/barbell-shrug.webp";
import bicepsCurl from "../../media/exercises/biceps-curl.webp";
import bodyweightCalfRaise from "../../media/exercises/bodyweight-calf-raise.webp";
import bodyweightLunge from "../../media/exercises/bodyweight-lunge.webp";
import bodyweightSquat from "../../media/exercises/bodyweight-squat.webp";
import buttLiftBridge from "../../media/exercises/butt-lift-bridge.webp";
import butterfly from "../../media/exercises/butterfly.webp";
import cableCrossover from "../../media/exercises/cable-crossover.webp";
import cableHipAbduction from "../../media/exercises/cable-hip-abduction.webp";
import cableLateralRaise from "../../media/exercises/cable-lateral-raise.webp";
import chinUp from "../../media/exercises/chin-up.webp";
import closeGripBarbellBenchPress from "../../media/exercises/close-grip-barbell-bench-press.webp";
import crossBodyHammerCurl from "../../media/exercises/cross-body-hammer-curl.webp";
import crunches from "../../media/exercises/crunches.webp";
import deadHang from "../../media/exercises/dead-hang.webp";
import deadlift from "../../media/exercises/deadlift.webp";
import dumbbellBenchPress from "../../media/exercises/dumbbell-bench-press.webp";
import dumbbellDeadlift from "../../media/exercises/dumbbell-deadlift.webp";
import dumbbellFlyes from "../../media/exercises/dumbbell-flyes.webp";
import dumbbellLunges from "../../media/exercises/dumbbell-lunges.webp";
import dumbbellRearLunge from "../../media/exercises/dumbbell-rear-lunge.webp";
import dumbbellRomanianDeadlift from "../../media/exercises/dumbbell-romanian-deadlift.webp";
import dumbbellShoulderPress from "../../media/exercises/dumbbell-shoulder-press.webp";
import dumbbellShrug from "../../media/exercises/dumbbell-shrug.webp";
import dumbbellSquat from "../../media/exercises/dumbbell-squat.webp";
import dumbbellWalkingLunge from "../../media/exercises/dumbbell-walking-lunge.webp";
import ezBarCurl from "../../media/exercises/ez-bar-curl.webp";
import facePull from "../../media/exercises/face-pull.webp";
import frontDumbbellRaise from "../../media/exercises/front-dumbbell-raise.webp";
import frontPlateRaise from "../../media/exercises/front-plate-raise.webp";
import gobletSquat from "../../media/exercises/goblet-squat.webp";
import hackSquat from "../../media/exercises/hack-squat.webp";
import hammerCurls from "../../media/exercises/hammer-curls.webp";
import hangingKneeRaise from "../../media/exercises/hanging-knee-raise.webp";
import hyperextensionsBackExtensions from "../../media/exercises/hyperextensions-back-extensions.webp";
import inclineDumbbellPress from "../../media/exercises/incline-dumbbell-press.webp";
import kettlebellSwing from "../../media/exercises/kettlebell-swing.webp";
import lateralLunge from "../../media/exercises/lateral-lunge.webp";
import lateralRaise from "../../media/exercises/lateral-raise.webp";
import legCurl from "../../media/exercises/leg-curl.webp";
import legExtensions from "../../media/exercises/leg-extensions.webp";
import legPress from "../../media/exercises/leg-press.webp";
import machineSeatedRow from "../../media/exercises/machine-seated-row.webp";
import oneArmDumbbellRow from "../../media/exercises/one-arm-dumbbell-row.webp";
import oneArmSideLaterals from "../../media/exercises/one-arm-side-laterals.webp";
import overheadPress from "../../media/exercises/overhead-press.webp";
import parallelBarDip from "../../media/exercises/parallel-bar-dip.webp";
import preacherCurl from "../../media/exercises/preacher-curl.webp";
import pullUp from "../../media/exercises/pull-up.webp";
import pushups from "../../media/exercises/pushups.webp";
import rackPulls from "../../media/exercises/rack-pulls.webp";
import reverseBarbellCurl from "../../media/exercises/reverse-barbell-curl.webp";
import romanianDeadlift from "../../media/exercises/romanian-deadlift.webp";
import seatedBarbellMilitaryPress from "../../media/exercises/seated-barbell-military-press.webp";
import seatedCableRows from "../../media/exercises/seated-cable-rows.webp";
import seatedLegCurl from "../../media/exercises/seated-leg-curl.webp";
import seatedSideLateralRaise from "../../media/exercises/seated-side-lateral-raise.webp";
import singleLegGluteBridge from "../../media/exercises/single-leg-glute-bridge.webp";
import splitSquatWithDumbbells from "../../media/exercises/split-squat-with-dumbbells.webp";
import standingDumbbellCalfRaise from "../../media/exercises/standing-dumbbell-calf-raise.webp";
import standingDumbbellPress from "../../media/exercises/standing-dumbbell-press.webp";
import standingDumbbellTricepsExtension from "../../media/exercises/standing-dumbbell-triceps-extension.webp";
import stiffLeggedBarbellDeadlift from "../../media/exercises/stiff-legged-barbell-deadlift.webp";
import sumoDeadlift from "../../media/exercises/sumo-deadlift.webp";
import trapBarDeadlift from "../../media/exercises/trap-bar-deadlift.webp";
import tricepsPushdown from "../../media/exercises/triceps-pushdown.webp";
import tricepsPushdownRopeAttachment from "../../media/exercises/triceps-pushdown-rope-attachment.webp";
import uprightBarbellRow from "../../media/exercises/upright-barbell-row.webp";
import wallSit from "../../media/exercises/wall-sit.webp";
import wideGripLatPulldown from "../../media/exercises/wide-grip-lat-pulldown.webp";
import zottmanCurl from "../../media/exercises/zottman-curl.webp";

/**
 * The exercise images (media/exercises), by built-in exercise id. Metro bundles an image only
 * when code imports it by a literal path, so each one is listed here.
 */
const IMAGES: Readonly<Record<string, ImageSourcePropType>> = {
  "builtin:ab-roller": abRoller,
  "builtin:arnold-dumbbell-press": arnoldDumbbellPress,
  "builtin:back-squat": backSquat,
  "builtin:barbell-bench-press": barbellBenchPress,
  "builtin:barbell-curl": barbellCurl,
  "builtin:barbell-glute-bridge": barbellGluteBridge,
  "builtin:barbell-hip-thrust": barbellHipThrust,
  "builtin:barbell-incline-bench-press-medium-grip": barbellInclineBenchPressMediumGrip,
  "builtin:barbell-row": barbellRow,
  "builtin:barbell-shrug": barbellShrug,
  "builtin:biceps-curl": bicepsCurl,
  "builtin:bodyweight-calf-raise": bodyweightCalfRaise,
  "builtin:bodyweight-lunge": bodyweightLunge,
  "builtin:bodyweight-squat": bodyweightSquat,
  "builtin:butt-lift-bridge": buttLiftBridge,
  "builtin:butterfly": butterfly,
  "builtin:cable-crossover": cableCrossover,
  "builtin:cable-hip-abduction": cableHipAbduction,
  "builtin:cable-lateral-raise": cableLateralRaise,
  "builtin:chin-up": chinUp,
  "builtin:close-grip-barbell-bench-press": closeGripBarbellBenchPress,
  "builtin:cross-body-hammer-curl": crossBodyHammerCurl,
  "builtin:crunches": crunches,
  "builtin:dead-hang": deadHang,
  "builtin:deadlift": deadlift,
  "builtin:dumbbell-bench-press": dumbbellBenchPress,
  "builtin:dumbbell-deadlift": dumbbellDeadlift,
  "builtin:dumbbell-flyes": dumbbellFlyes,
  "builtin:dumbbell-lunges": dumbbellLunges,
  "builtin:dumbbell-rear-lunge": dumbbellRearLunge,
  "builtin:dumbbell-romanian-deadlift": dumbbellRomanianDeadlift,
  "builtin:dumbbell-shoulder-press": dumbbellShoulderPress,
  "builtin:dumbbell-shrug": dumbbellShrug,
  "builtin:dumbbell-squat": dumbbellSquat,
  "builtin:dumbbell-walking-lunge": dumbbellWalkingLunge,
  "builtin:ez-bar-curl": ezBarCurl,
  "builtin:face-pull": facePull,
  "builtin:front-dumbbell-raise": frontDumbbellRaise,
  "builtin:front-plate-raise": frontPlateRaise,
  "builtin:goblet-squat": gobletSquat,
  "builtin:hack-squat": hackSquat,
  "builtin:hammer-curls": hammerCurls,
  "builtin:hanging-knee-raise": hangingKneeRaise,
  "builtin:hyperextensions-back-extensions": hyperextensionsBackExtensions,
  "builtin:incline-dumbbell-press": inclineDumbbellPress,
  "builtin:kettlebell-swing": kettlebellSwing,
  "builtin:lateral-lunge": lateralLunge,
  "builtin:lateral-raise": lateralRaise,
  "builtin:leg-curl": legCurl,
  "builtin:leg-extensions": legExtensions,
  "builtin:leg-press": legPress,
  "builtin:machine-seated-row": machineSeatedRow,
  "builtin:one-arm-dumbbell-row": oneArmDumbbellRow,
  "builtin:one-arm-side-laterals": oneArmSideLaterals,
  "builtin:overhead-press": overheadPress,
  "builtin:parallel-bar-dip": parallelBarDip,
  "builtin:preacher-curl": preacherCurl,
  "builtin:pull-up": pullUp,
  "builtin:pushups": pushups,
  "builtin:rack-pulls": rackPulls,
  "builtin:reverse-barbell-curl": reverseBarbellCurl,
  "builtin:romanian-deadlift": romanianDeadlift,
  "builtin:seated-barbell-military-press": seatedBarbellMilitaryPress,
  "builtin:seated-cable-rows": seatedCableRows,
  "builtin:seated-leg-curl": seatedLegCurl,
  "builtin:seated-side-lateral-raise": seatedSideLateralRaise,
  "builtin:single-leg-glute-bridge": singleLegGluteBridge,
  "builtin:split-squat-with-dumbbells": splitSquatWithDumbbells,
  "builtin:standing-dumbbell-calf-raise": standingDumbbellCalfRaise,
  "builtin:standing-dumbbell-press": standingDumbbellPress,
  "builtin:standing-dumbbell-triceps-extension": standingDumbbellTricepsExtension,
  "builtin:stiff-legged-barbell-deadlift": stiffLeggedBarbellDeadlift,
  "builtin:sumo-deadlift": sumoDeadlift,
  "builtin:trap-bar-deadlift": trapBarDeadlift,
  "builtin:triceps-pushdown": tricepsPushdown,
  "builtin:triceps-pushdown-rope-attachment": tricepsPushdownRopeAttachment,
  "builtin:upright-barbell-row": uprightBarbellRow,
  "builtin:wall-sit": wallSit,
  "builtin:wide-grip-lat-pulldown": wideGripLatPulldown,
  "builtin:zottman-curl": zottmanCurl,
};

/** The exercise's image, or null when it has none (most exercises, and every custom one). */
export function exerciseImage(id: string): ImageSourcePropType | null {
  return Object.hasOwn(IMAGES, id) ? (IMAGES[id] ?? null) : null;
}
