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

/** A user as an Admin sees them: the person from the log, plus the credential side (FR-USR-04). */
export interface AccountUser extends User {
  email: string;
  has_password: boolean;
}

/** A phone with an open session (FR-USR-14). `created_at` is its latest sign-in. */
export interface Device {
  device_id: string;
  created_at: number;
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

/** What a photo may be. Matches PHOTO_TYPES on the server. */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

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

  /** Bytes, not JSON: photos go up and come down whole. */
  async function raw(method: string, path: string, body?: Blob, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    const bearer = token();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (contentType) headers["Content-Type"] = contentType;
    let response: Response;
    try {
      response = await fetchFn(base + path, { method, headers, body });
    } catch (error) {
      throw new Offline(String(error));
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText);
    }
    return response;
  }

  return {
    bootstrap: () => request<Bootstrap>("GET", "/sync/bootstrap"),
    pull: (since: number) => request<Pull>("GET", `/sync/pull?since=${since}`),
    push: (device_id: string, client_time: number, events: OutgoingEvent[]) =>
      request<PushResult>("POST", "/sync/push", { device_id, client_time, events }),
    signIn: (email: string, password: string, device_id: string) =>
      request<Session>("POST", "/auth/sign-in", { email, password, device_id }),
    signOut: () => request<Record<string, never>>("POST", "/auth/sign-out"),
    /** Use an invite or reset link (FR-USR-12): set a password, open this device's session. */
    redeem: (token: string, password: string, device_id: string) =>
      request<Session>("POST", "/auth/redeem", { token, password, device_id }),
    // Admins only. Every call needs the network; nothing here is stored on the device.
    users: () => request<{ users: AccountUser[] }>("GET", "/users"),
    invite: (name: string, email: string, role: string) =>
      request<{ user_id: string; token: string }>("POST", "/users/invite", { name, email, role }),
    setRole: (userId: string, role: string) => request<{ user: User }>("POST", `/users/${userId}/role`, { role }),
    deactivate: (userId: string) => request<{ user: User }>("POST", `/users/${userId}/deactivate`),
    reactivate: (userId: string) => request<{ user: User }>("POST", `/users/${userId}/reactivate`),
    resetLink: (userId: string) => request<{ token: string }>("POST", `/users/${userId}/reset-link`),
    devices: (userId: string) => request<{ devices: Device[] }>("GET", `/users/${userId}/devices`),
    revokeDevice: (userId: string, deviceId: string) =>
      request<{ devices: Device[] }>("POST", `/users/${userId}/devices/${deviceId}/revoke`),
    publicCode: (code: string) => request<PublicCode>("GET", `/public/codes/${code}`),
    /** A finder's note (FR-PUB-02). `website` is a honeypot: people never see it, so it is sent empty. */
    reportFound: (code: string, body: { note: string; contact: string; website: string }) =>
      request<Record<string, never>>("POST", `/public/codes/${code}/found`, body),
    /** The bytes under an id the device made (FR-INV-11). The server records the event; a retry is harmless. */
    uploadPhoto: async (id: string, entity_type: string, entity_id: string, blob: Blob, contentType: string) => {
      const query = new URLSearchParams({ entity_type, entity_id });
      await raw("PUT", `/photos/${id}?${query}`, blob, contentType);
    },
    /** An <img> cannot send the bearer header, so the bytes are fetched and shown from memory. */
    fetchPhoto: async (id: string): Promise<Blob> => (await raw("GET", `/photos/${id}`)).blob(),
  };
}
