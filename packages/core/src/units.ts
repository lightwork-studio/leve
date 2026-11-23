export const LB_PER_KG = 2.20462;
export const M_PER_MILE = 1609.34;
export const M_PER_YARD = 0.9144;
export const CM_PER_INCH = 2.54;

export type WeightUnit = "kg" | "lbs";
export type DistanceUnit = "km" | "miles";
export type ShortDistanceUnit = "m" | "yd";
export type LengthUnit = "cm" | "in";

export const kgToLbs = (kg: number) => kg * LB_PER_KG;
export const lbsToKg = (lbs: number) => lbs / LB_PER_KG;
export const metresToMiles = (m: number) => m / M_PER_MILE;
export const milesToMetres = (miles: number) => miles * M_PER_MILE;

/** Round for display; never round stored values. */
export const round = (value: number, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

export const weightFromKg = (kg: number, unit: WeightUnit) => (unit === "kg" ? kg : kgToLbs(kg));
export const weightToKg = (value: number, unit: WeightUnit) =>
  unit === "kg" ? value : lbsToKg(value);
export type SetDistanceUnit = DistanceUnit | ShortDistanceUnit;

const metresPerUnit: Record<SetDistanceUnit, number> = {
  m: 1,
  yd: M_PER_YARD,
  km: 1000,
  miles: M_PER_MILE,
};

export const distanceFromMetres = (m: number, unit: SetDistanceUnit) => m / metresPerUnit[unit];
export const distanceToMetres = (value: number, unit: SetDistanceUnit) =>
  value * metresPerUnit[unit];
