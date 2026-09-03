export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const ZONE = "America/Vancouver";

/** The calendar day an instant fell on where the group is (NFR-DATA-12): "2026-09-01". */
export function localDate(ms: number, timeZone = ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms))
    .filter((p) => p.type !== "literal")
    .map((p) => p.value);
  const [year, month, day] = parts;
  return `${year}-${month}-${day}`;
}

/** "2026-09-01 14:02", where the group is. */
export function localMinute(ms: number, timeZone = ZONE): string {
  const time = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(ms))
    .replace(/^24/, "00");
  return `${localDate(ms, timeZone)} ${time}`;
}
