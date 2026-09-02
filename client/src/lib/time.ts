export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** 2026-09-01, the way a Quartermaster reads a date. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
