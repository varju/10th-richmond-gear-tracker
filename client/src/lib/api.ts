/**
 * The server's HTTP API, as typed functions. Every response carries
 * server_time, so every call also yields a fresh clock offset (NFR-DATA-13).
 */
import { measureOffset } from "./clock";
import type { ReplayEvent, State } from "./replay";

/** An event as the server stores it. */
export interface ServerEvent extends ReplayEvent {
  seq: number;
  occurred_at: number;
  clock_offset: number;
  received_at: number;
}

/** An event as this device sends it. The server assigns the rest. */
export interface OutgoingEvent extends Omit<ReplayEvent, "effective_at"> {
  occurred_at: number;
  clock_offset: number;
}

export interface User {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface Bootstrap {
  snapshot: State;
  cursor: number;
}
export interface Pull {
  events: ServerEvent[];
  cursor: number;
}
export interface PushResult {
  accepted: string[];
  rejected: { id: string | null; reason: string }[];
}
export interface Session {
  token: string;
  user: User;
}

/** All a scan shows to someone with no account (FR-PUB-01). */
export interface PublicCode {
  item: { name: string } | null;
  group: { name: string; contact: string };
}

export interface Timed<T> {
  data: T;
  offset: number;
}

/** The server answered, and said no. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public offset?: number,
  ) {
    super(message);
  }
}

/** The server did not answer. Normal in a locker. */
export class Offline extends Error {}

export interface ApiOptions {
  fetch?: typeof fetch;
  now?: () => number;
  token?: () => string | null | undefined;
  base?: string;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(options: ApiOptions = {}) {
  const { now = Date.now, token = () => null, base = "" } = options;
  const fetchFn = options.fetch ?? ((...args) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown): Promise<Timed<T>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearer = token();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const sentAt = now();
    let response: Response;
    try {
      response = await fetchFn(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Offline(String(error));
    }
    const receivedAt = now();

    const data = (await response.json()) as T & { server_time: number; error?: string; message?: string };
    const offset = measureOffset(data.server_time, sentAt, receivedAt);
    if (!response.ok)
      throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText, offset);
    return { data, offset };
  }

  return {
    bootstrap: () => request<Bootstrap>("GET", "/sync/bootstrap"),
    pull: (since: number) => request<Pull>("GET", `/sync/pull?since=${since}`),
    push: (device_id: string, client_time: number, events: OutgoingEvent[]) =>
      request<PushResult>("POST", "/sync/push", { device_id, client_time, events }),
    signIn: (email: string, password: string, device_id: string) =>
      request<Session>("POST", "/auth/sign-in", { email, password, device_id }),
    signOut: () => request<Record<string, never>>("POST", "/auth/sign-out"),
    publicCode: (code: string) => request<PublicCode>("GET", `/public/codes/${code}`),
  };
}
