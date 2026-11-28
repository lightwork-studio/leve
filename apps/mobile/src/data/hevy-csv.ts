import {
  distanceToMetres,
  LIMITS,
  RPE_VALUES,
  type WorkoutSetContent,
  weightToKg,
} from "@leve/core";

export class HevyImportError extends Error {}

export type HevySet = Pick<
  WorkoutSetContent,
  "type" | "weightKg" | "reps" | "distanceMeters" | "durationSeconds" | "rpe"
>;

export interface HevyExercise {
  name: string;
  notes: string;
  supersetId: number | null;
  sets: HevySet[];
  /** The CSV row of the entry's first line, and of each set. */
  row: number;
  setRows: number[];
}

export interface HevyWorkout {
  minute: string;
  title: string;
  startedAt: string;
  endedAt: string;
  description: string;
  exercises: HevyExercise[];
  row: number;
}

/** Read a comma-delimited export, including doubled quotes and newlines inside quoted fields. */
function* csvRows(source: string) {
  const csv = source.replace(/^\uFEFF/, "");
  const field = /"((?:[^"]|"")*)"|([^",\r\n]*)/y;
  let offset = 0;
  let rowNumber = 1;
  let fields: string[] = [];
  while (offset < csv.length) {
    field.lastIndex = offset;
    const match = field.exec(csv);
    if (!match) throw rowError(rowNumber, "invalid CSV quoting");
    fields.push(match[1]?.replaceAll('""', '"') ?? match[2] ?? "");
    offset = field.lastIndex;
    const delimiter = csv[offset++];
    if (delimiter === ",") {
      if (offset === csv.length) fields.push("");
      continue;
    }
    if (delimiter === "\r" && csv[offset] === "\n") offset++;
    if (delimiter !== undefined && delimiter !== "\r" && delimiter !== "\n")
      throw rowError(rowNumber, "invalid CSV quoting");
    if (fields.length !== 1 || fields[0]?.trim()) yield { fields, rowNumber };
    fields = [];
    rowNumber++;
  }
  if (fields.length) yield { fields, rowNumber };
}

/**
 * Hevy writes month names in the app's language ("22 Nov 2026", "22 Nov. 2026", "4 März 2026").
 * Each month's names in the languages Leve can read, without accents. A name or abbreviation
 * matches when it starts one of them and only one month's names.
 */
const MONTH_NAMES = [
  "january januar janner janvier enero gennaio janeiro januari",
  "february februar fevrier febrero febbraio fevereiro februari",
  "march marz mars marzo marco maart",
  "april avril abril aprile",
  "may mai mayo maggio maio mei",
  "june juni juin junio giugno junho",
  "july juli juillet julio luglio julho",
  "august aout agosto augustus",
  "september septembre septiembre settembre setembro",
  "october oktober octobre octubre ottobre outubro",
  "november novembre noviembre novembro",
  "december dezember decembre diciembre dicembre dezembro",
].map((names) => names.split(" "));

const plainLetters = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** The month a written month name means, from 0, or -1 when it means none or several. */
function monthIndex(written: string) {
  const name = plainLetters(written).replace(/\.$/, "");
  if (name.length < 3) return -1;
  const months = MONTH_NAMES.flatMap((names, index) =>
    names.some((full) => full.startsWith(name)) ? [index] : [],
  );
  return months.length === 1 ? (months[0] ?? -1) : -1;
}

const DATE_TIME =
  /^(\d{1,2})\.? (?:de )?([^\s\d.,]+\.?) (?:de )?([1-9]\d{3}),? (\d{1,2}):(\d{2})(?: ?([ap])\.? ?m\.?)?$/i;

const REQUIRED_COLUMNS = [
  "title",
  "start_time",
  "end_time",
  "description",
  "exercise_title",
  "superset_id",
  "exercise_notes",
  "set_index",
  "set_type",
  "reps",
  "duration_seconds",
  "rpe",
];

function rowError(row: number, message: string) {
  return new HevyImportError(`Hevy CSV row ${row} has ${message}.`);
}

/** The CSV gives clock times without a time zone. Use the device's zone for the stored timestamp. */
function date(value: string, row: number, column: string) {
  const match = DATE_TIME.exec(value.trim().replace(/\s+/g, " "));
  if (!match) throw rowError(row, `an invalid ${column}`);
  const day = Number(match[1]);
  const month = monthIndex(match[2] ?? "");
  const year = Number(match[3]);
  const clockHour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6]?.toLowerCase();
  // A 12-hour clock: 12 AM is midnight and 12 PM noon.
  const hour = meridiem ? (clockHour % 12) + (meridiem === "p" ? 12 : 0) : clockHour;
  const utc = new Date(Date.UTC(year, month, day, hour, minute));
  if (
    month < 0 ||
    utc.getUTCDate() !== day ||
    (meridiem ? clockHour < 1 || clockHour > 12 : hour > 23) ||
    minute > 59
  )
    throw rowError(row, `an invalid ${column}`);
  return {
    key: utc.toISOString().slice(0, 16).replace(/\D/g, ""),
    timestamp: new Date(year, month, day, hour, minute).toISOString(),
  };
}

function number(value: string, row: number, column: string, minimum = 0): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) || !Number.isFinite(parsed) || parsed < minimum)
    throw rowError(row, `an invalid ${column}`);
  return parsed;
}

function index(value: string, row: number, column: string): number | null {
  const parsed = number(value, row, column);
  if (parsed !== null && !Number.isSafeInteger(parsed)) throw rowError(row, `an invalid ${column}`);
  return parsed;
}

/** Hevy offers RPE from 6 to 10 in half steps; Leve keeps 1 to 10 in half steps. */
function rpe(value: string, row: number): number | null {
  const parsed = number(value, row, "RPE");
  if (parsed !== null && !(RPE_VALUES as readonly number[]).includes(parsed))
    throw rowError(row, "an invalid RPE");
  return parsed;
}

function setType(value: string, row: number): HevySet["type"] {
  switch (value.trim().toLowerCase()) {
    case "":
    case "normal":
      return "normal";
    case "warmup":
      return "warmup";
    case "failure":
      return "failure";
    // Hevy writes "dropset"; "drop_set" is accepted as well.
    case "dropset":
    case "drop_set":
      return "drop";
    default:
      throw rowError(row, "an unrecognized set type");
  }
}

/** Each group of contiguous workout metadata describes a session. set_index resets for each entry,
 * including when the same exercise appears twice consecutively. */
export function parseHevyCsv(csv: string): HevyWorkout[] {
  const rows = csvRows(csv);
  const header = rows.next().value?.fields.map((name) => name.trim().toLowerCase()) ?? [];
  const columns = new Map(header.map((name, index) => [name, index]));
  const weight = columns.has("weight_kg") ? "weight_kg" : "weight_lbs";
  const distance = columns.has("distance_km") ? "distance_km" : "distance_miles";
  if (
    columns.size !== header.length ||
    ![...REQUIRED_COLUMNS, weight, distance].every((name) => columns.has(name))
  )
    throw new HevyImportError("Choose a workout CSV exported from Hevy.");

  const workouts: HevyWorkout[] = [];
  let workout: HevyWorkout | undefined;
  let exercise: HevyExercise | undefined;
  let lastWorkoutKey = "";
  let lastSetIndex = -1;
  for (const { fields, rowNumber } of rows) {
    if (fields.length !== header.length) throw rowError(rowNumber, "the wrong number of fields");
    const get = (column: string) => fields[columns.get(column) ?? -1] ?? "";
    const start = get("start_time");
    const end = get("end_time");
    const title = get("title").trim();
    const description = get("description");
    const key = JSON.stringify([start, end, title, description]);
    if (!workout || key !== lastWorkoutKey) {
      if (title.length > LIMITS.titleLength)
        throw rowError(rowNumber, "a workout title that is too long");
      if (description.length > LIMITS.noteLength)
        throw rowError(rowNumber, "a workout description that is too long");
      const started = date(start, rowNumber, "start time");
      const ended = date(end, rowNumber, "end time");
      if (ended.timestamp < started.timestamp)
        throw rowError(rowNumber, "an end time before its start time");
      workout = {
        minute: started.key,
        title,
        description,
        startedAt: started.timestamp,
        endedAt: ended.timestamp,
        exercises: [],
        row: rowNumber,
      };
      workouts.push(workout);
      lastWorkoutKey = key;
      exercise = undefined;
    }

    const name = get("exercise_title").trim();
    const notes = get("exercise_notes");
    const setIndex = index(get("set_index"), rowNumber, "set index");
    const supersetId = index(get("superset_id"), rowNumber, "superset ID");
    const weightValue = number(get(weight), rowNumber, "weight", -Infinity);
    const distanceValue = number(get(distance), rowNumber, "distance");
    const set = {
      weightKg:
        weightValue === null
          ? null
          : weightToKg(weightValue, weight === "weight_kg" ? "kg" : "lbs"),
      distanceMeters:
        distanceValue === null
          ? null
          : distanceToMetres(distanceValue, distance === "distance_km" ? "km" : "miles"),
      reps: index(get("reps"), rowNumber, "rep count"),
      durationSeconds: number(get("duration_seconds"), rowNumber, "duration"),
      rpe: rpe(get("rpe"), rowNumber),
    };
    const hasSet =
      get("set_type").trim() !== "" || Object.values(set).some((value) => value !== null);
    if (!name) {
      if (hasSet || notes.trim() || supersetId !== null)
        throw rowError(rowNumber, "set or exercise details without an exercise name");
      continue;
    }
    if (name.length > LIMITS.titleLength)
      throw rowError(rowNumber, "an exercise name that is too long");
    if (notes.length > LIMITS.noteLength)
      throw rowError(rowNumber, "exercise notes that are too long");
    if (
      !exercise ||
      name !== exercise.name ||
      supersetId !== exercise.supersetId ||
      (setIndex !== null && setIndex <= lastSetIndex)
    ) {
      exercise = { name, notes, supersetId, sets: [], row: rowNumber, setRows: [] };
      workout.exercises.push(exercise);
      lastSetIndex = -1;
    } else if (notes.trim() && !exercise.notes.trim()) {
      exercise.notes = notes;
    } else if (notes.trim() && notes !== exercise.notes) {
      throw rowError(rowNumber, "different notes for the same exercise entry");
    }
    if (hasSet) {
      exercise.sets.push({ ...set, type: setType(get("set_type"), rowNumber) });
      exercise.setRows.push(rowNumber);
    }
    lastSetIndex = setIndex ?? lastSetIndex + 1;
  }
  if (workouts.length === 0) throw new HevyImportError("This Hevy CSV has no workouts to import.");
  return workouts;
}
