export type DayPhase = "morning" | "day" | "evening" | "night";

export function dayPhaseForHour(hour: number): DayPhase {
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}
