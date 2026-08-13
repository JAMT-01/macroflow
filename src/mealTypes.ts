import type { MealType } from "./types";

/**
 * The five Argentine diary categories. The four standard GAPA meals
 * (desayuno, almuerzo, merienda, cena) plus a discretionary "antojo".
 */
export const mealTypes: MealType[] = ["Breakfast", "Lunch", "Merienda", "Dinner", "Treat"];

export const mealTypeMeta: Record<MealType, { emoji: string; hint: string; window: string }> = {
  Breakfast: { emoji: "☀️", hint: "desayuno", window: "05:00–11:00" },
  Lunch: { emoji: "🥗", hint: "almuerzo", window: "11:00–15:30" },
  Merienda: { emoji: "🧉", hint: "la merienda", window: "15:30–19:30" },
  Dinner: { emoji: "🌙", hint: "cena", window: "19:30–02:00" },
  Treat: { emoji: "🍫", hint: "antojo", window: "any time" }
};

/**
 * Offline fallback for the "Auto" category when nothing has been analyzed yet,
 * such as manual search or quick-add entries. It mirrors the local-time bands of
 * `suggestArgentineMealType` in server/analysis.ts; the server (with the photo,
 * the note, and the model) remains the authority whenever an analysis exists.
 */
export function guessMealTypeFromLocalTime(localTime: string): MealType {
  const match = localTime.match(/^(\d{2}):(\d{2})$/);
  if (!match) return "Lunch";
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes >= 5 * 60 && minutes < 11 * 60) return "Breakfast";
  if (minutes >= 11 * 60 && minutes < 15 * 60 + 30) return "Lunch";
  if (minutes >= 15 * 60 + 30 && minutes < 19 * 60 + 30) return "Merienda";
  return "Dinner";
}
