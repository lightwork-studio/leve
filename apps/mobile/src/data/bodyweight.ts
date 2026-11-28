import { leveContract } from "@leve/contract";
import { type WeightUnit, weightToKg } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { newId } from "./ids.ts";

function parseBodyweight(text: string, unit: WeightUnit) {
  const value = text.trim().replace(",", ".");
  const bodyweightKg = weightToKg(Number(value), unit);
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(bodyweightKg) || bodyweightKg <= 0) {
    throw new Error("Enter a bodyweight greater than zero.");
  }
  return bodyweightKg;
}

function validateMeasurement(content: Record<string, unknown>) {
  if (leveContract.validateContent("body_measurement", content).length) {
    throw new Error("Bodyweight exceeds the supported range.");
  }
}

export function recordBodyweight(
  store: DeviceStore,
  text: string,
  unit: WeightUnit,
  now = new Date(),
) {
  const content = {
    takenAt: now.toISOString(),
    bodyweightKg: parseBodyweight(text, unit),
    fatPercent: null,
  };
  validateMeasurement(content);
  return store.put("body_measurement", newId(), content);
}

export function correctBodyweight(
  store: DeviceStore,
  original: { id: string; kg: number; at: number },
  text: string,
  unit: WeightUnit,
) {
  const row = store.get("body_measurement", original.id);
  if (!row?.content || row.deleted) throw new Error("This measurement is no longer available.");
  if (row.status === "conflict")
    throw new Error("Resolve the conflicting measurement before editing it.");
  if (
    row.content.bodyweightKg !== original.kg ||
    Date.parse(String(row.content.takenAt)) !== original.at
  ) {
    throw new Error("This measurement changed. Cancel and reopen it to use the latest reading.");
  }
  const bodyweightKg = parseBodyweight(text, unit);
  const content = { ...row.content, bodyweightKg };
  validateMeasurement(content);
  if (bodyweightKg !== original.kg) store.put("body_measurement", original.id, content);
}

/**
 * Deletes a reading as the person saw it when they asked. A reading already gone has nothing left
 * to delete; one that changed since, or that sync is still settling, is refused instead.
 */
export function deleteBodyweight(
  store: DeviceStore,
  original: { id: string; kg: number; at: number },
) {
  const row = store.get("body_measurement", original.id);
  if (!row?.content || row.deleted) return;
  if (row.status === "conflict")
    throw new Error("Resolve the conflicting measurement before deleting it.");
  if (row.fromRestore) throw new Error("Sync this measurement before deleting it.");
  if (
    row.content.bodyweightKg !== original.kg ||
    Date.parse(String(row.content.takenAt)) !== original.at
  ) {
    throw new Error("This measurement changed. Try again to delete the latest reading.");
  }
  store.delete("body_measurement", original.id);
}
