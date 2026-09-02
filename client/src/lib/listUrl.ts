/**
 * The list's search and filters live in the URL, not in component state, so
 * back brings the screen back as it was. Empty values are left out, which
 * keeps a plain list at a plain path.
 */
import type { Filter } from "./inventory";

const STATUSES = ["in", "out", "missing"] as const;

/** Read what the list should show from the query string. Anything unrecognised is ignored. */
export function readFilter(query: URLSearchParams): Filter {
  const status = STATUSES.find((s) => s === query.get("status"));
  return {
    location_id: query.get("location") || undefined,
    sub_location: query.get("sub") || undefined,
    status,
    retired: query.get("retired") === "1" || undefined,
  };
}

export function filterParams(text: string, filter: Filter): URLSearchParams {
  const params = new URLSearchParams();
  if (text) params.set("q", text);
  if (filter.location_id) params.set("location", filter.location_id);
  if (filter.sub_location) params.set("sub", filter.sub_location);
  if (filter.status) params.set("status", filter.status);
  if (filter.retired) params.set("retired", "1");
  return params;
}

export const withQuery = (path: string, params: URLSearchParams): string => {
  const q = params.toString();
  return q ? `${path}?${q}` : path;
};
