/**
 * Gear weighed to see what is left, such as a propane tank (FR-INV-62 to FR-INV-68). An item has an empty
 * weight and a capacity, each a number in lb or kg. A reading is kept as typed; it is converted only here, for
 * showing. Mirrors `weighing` and `amount_left` in views.py.
 */
import type { Item } from "./inventory";
import { item } from "./inventory";
import type { State } from "./replay";

export type WeightUnit = "lb" | "kg";
export const WEIGHT_UNITS: WeightUnit[] = ["lb", "kg"];

export interface Weight {
  value: number;
  unit: WeightUnit;
}

/** The latest reading: a weight, or full after Refilled. Unknown is no reading at all. `at` is when. */
export type Reading = (
  | { value: number; unit: WeightUnit; at: number; full?: undefined }
  | { full: true; at: number }
) & {
  /** The item has been out since: a build that does not weigh may have brought it back unread (FR-INV-69). */
  stale?: true;
};

export const LB_PER_KG = 2.20462262185;

export function convert(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value;
  return to === "lb" ? value * LB_PER_KG : value / LB_PER_KG;
}

/** To one decimal, halves up. */
export function roundTenth(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10;
}

/** What a person typed in a weight box: a number of zero or more, else null. */
export function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A weight a device could have written: a finite number of zero or more, in lb or kg. Mirrors `_sound` in views.py. */
export const isWeight = (w: unknown): w is Weight =>
  typeof w === "object" &&
  w !== null &&
  typeof (w as Weight).value === "number" &&
  Number.isFinite((w as Weight).value) &&
  (w as Weight).value >= 0 &&
  ((w as Weight).unit === "lb" || (w as Weight).unit === "kg");

export interface Weighing {
  empty_weight: Weight;
  capacity: Weight;
  /** The item's own unit: its empty weight's. */
  unit: WeightUnit;
}

/**
 * Set up to be weighed: an empty weight and a capacity, which a unit takes from its generic when it has none
 * (FR-INV-63). A generic is never weighed itself.
 */
export function weighing(state: State, it: Item): Weighing | null {
  if (it.generic) return null;
  const parent = it.parent_id ? item(state, it.parent_id) : undefined;
  const empty = it.empty_weight;
  const capacity = it.capacity ?? parent?.capacity;
  if (!isWeight(empty) || !isWeight(capacity) || capacity.value <= 0) return null;
  return { empty_weight: empty, capacity, unit: empty.unit };
}

export interface AmountLeft {
  left: number;
  unit: WeightUnit;
  percent: number;
  full: boolean;
  at: number;
}

/** What is left, from the latest reading, in the item's own unit (FR-INV-66). Null when unweighed or Unknown. */
export function amountLeft(state: State, it: Item): AmountLeft | null {
  const w = weighing(state, it);
  const reading = it.reading as Reading | null | undefined;
  if (!w || !reading || typeof reading !== "object" || reading.stale) return null;
  if (!reading.full && !isWeight(reading)) return null;
  const capacity = convert(w.capacity.value, w.capacity.unit, w.unit);
  const left = reading.full
    ? capacity
    : Math.min(Math.max(convert(reading.value, reading.unit, w.unit) - w.empty_weight.value, 0), capacity);
  return {
    left: roundTenth(left),
    unit: w.unit,
    percent: Math.floor((left / capacity) * 100 + 0.5),
    full: Boolean(reading.full),
    at: reading.at,
  };
}

/** The last reading was taken before the item last went out, so it is no guide (FR-INV-69). */
export function readingIsStale(state: State, it: Item): boolean {
  return weighing(state, it) !== null && Boolean((it.reading as Reading | null | undefined)?.stale);
}

/** "About 8 lb left (40%)", or "Full (20 lb)" after Refilled. */
export function leftLabel(a: AmountLeft): string {
  return a.full ? `Full (${a.left} ${a.unit})` : `About ${a.left} ${a.unit} left (${a.percent}%)`;
}

/** "10 lb", "4.5 kg". */
export const weightLabel = (w: Weight): string => `${w.value} ${w.unit}`;
