/**
 * Records a Hevy import creates have ids derived from the file, so importing it again, here or on
 * another phone, finds them. Every such id starts with this.
 */
export const HEVY_ID_PREFIX = "hevy:";
/** Workout ids add the CSV's wall-clock start minute and its occurrence within the file. */
export const HEVY_WORKOUT_ID_PREFIX = `${HEVY_ID_PREFIX}workout:`;
/** Custom exercise ids add a hash of the exercise's normalised name. */
export const HEVY_EXERCISE_ID_PREFIX = `${HEVY_ID_PREFIX}exercise:`;
