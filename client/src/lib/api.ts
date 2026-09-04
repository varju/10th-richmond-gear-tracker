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

/**
 * One SMTP account, so the server can mail a link (FR-USR-15). Admins only,
 * and never stored on the device. The password is write-only: `has_password`
 * says whether one is held, and a blank password on save keeps it.
 */
export interface MailSettings {
  host: string;
  port: number;
  encryption: "none" | "starttls" | "ssl";
  username: string;
  from_address: string;
  has_password: boolean;
}

/** Email a person chooses to get, one flag per event kind. Nothing is sent unless mail is set up too. */
export interface NotificationCategories {
  found: boolean;
  repair: boolean;
  joined: boolean;
}

export interface NotificationSettings {
  categories: NotificationCategories;
  mail_configured: boolean;
}

/** What the server did with a one-time link. `emailed` is false when no account is set up. */
export interface LinkResult {
  token: string;
  emailed: boolean;
  mail_error?: string;
}

/** A device or an assistant with an open session (FR-USR-14). `created_at` is its latest sign-in. */
export interface Device {
  device_id: string;
  created_at: number;
}

/** What makes a device an assistant rather than an ordinary device (FR-MCP-02). Matches accounts.py. */
export const ASSISTANT_PREFIX = "mcp-";

export const isAssistant = (deviceId: string): boolean => deviceId.startsWith(ASSISTANT_PREFIX);

/** A token for an MCP client, shown once (FR-MCP-01). `path` is where that client connects. */
export interface AssistantToken {
  token: string;
  device_id: string;
  path: string;
}

export interface Bootstrap {
  snapshot: State;
  cursor: number;
  log_id: string;
}
export interface Pull {
  events: ServerEvent[];
  cursor: number;
  log_id: string;
}
export interface History {
  events: ServerEvent[];
}
export interface PushResult {
  accepted: string[];
  rejected: { id: string | null; reason: string }[];
  log_id: string;
}
export interface Session {
  token: string;
  user: User;
}

/** All a scan shows to someone with no account: not the item, so a sticker cannot be used to browse the inventory (FR-PUB-01). */
export interface PublicCode {
  group: { name: string; contact: string };
}

export interface Timed<T> {
  data: T;
  /** Only a server that stamped its own reply gives us one to measure against (see `request`). */
  offset?: number;
  /** Wall-clock time this call took. Sent back on the next push so the server can allow for latency. */
  round_trip: number;
}

/** What an import would do, without doing it: rows to add or change, and any errors (FR-SET-11). */
export interface ImportPlan {
  adds: number;
  changes: number;
  unchanged: number;
  new_locations: string[];
  new_categories: string[];
  rows: {
    row: number;
    action: "add" | "change";
    name: string;
    changes: { field: string; old: string; new: string }[];
  }[];
  errors: { row: number; message: string }[];
}

/** What an import wrote: counts, plus any locations or categories it created along the way. */
export interface ImportResult {
  added: number;
  changed: number;
  created_locations: string[];
  created_categories: string[];
}

/** The server answered, and said no. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public offset?: number,
    public round_trip?: number,
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
    const round_trip = receivedAt - sentAt;

    // A body that is not JSON (a proxy's HTML error page, say) is not a reason to blow up the
    // caller: treat it as empty, and let the status code carry the story.
    const data = (await response.json().catch(() => ({}))) as Partial<
      T & { server_time: number; error?: string; message?: string }
    >;
    // Only a handler that calls back through our own error paths stamps server_time; an
    // unhandled 500 or a framework's own 404 does not, so there is nothing to measure against.
    const offset = Number.isFinite(data.server_time) ? measureOffset(data.server_time!, sentAt, receivedAt) : undefined;
    if (!response.ok)
      throw new ApiError(
        response.status,
        data.error ?? "error",
        data.message ?? response.statusText,
        offset,
        round_trip,
      );
    return { data: data as T, offset, round_trip };
  }

  /** Bytes, not JSON: photos go up and come down whole. */
  async function raw(method: string, path: string, body?: BodyInit, contentType?: string): Promise<Response> {
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
    /** `log` is the log this device's snapshot came from; a different one on the server means re-bootstrap. */
    pull: (since: number, log?: string) =>
      request<Pull>("GET", `/sync/pull?since=${since}${log === undefined ? "" : `&log=${encodeURIComponent(log)}`}`),
    /**
     * The whole record for one entity, or for every entity of a kind (FR-INV-31).
     * A device holds 90 days; this reaches back as far as the log goes.
     */
    history: (entity_type: string, entity_id?: string) =>
      request<History>(
        "GET",
        entity_id === undefined ? `/history/${entity_type}` : `/history/${entity_type}/${entity_id}`,
      ),
    push: (device_id: string, client_time: number, events: OutgoingEvent[], round_trip_ms?: number) =>
      request<PushResult>(
        "POST",
        "/sync/push",
        round_trip_ms === undefined
          ? { device_id, client_time, events }
          : { device_id, client_time, events, round_trip_ms },
      ),
    signIn: (email: string, password: string, device_id: string) =>
      request<Session>("POST", "/auth/sign-in", { email, password, device_id }),
    signOut: () => request<Record<string, never>>("POST", "/auth/sign-out"),
    /** Mint a token for an assistant (FR-MCP-01). Any signed-in person; no Admin involved. */
    connectAssistant: () => request<AssistantToken>("POST", "/assistant/connect"),
    /** Use an invite or reset link (FR-USR-12): set a password, open this device's session. */
    redeem: (token: string, password: string, device_id: string) =>
      request<Session>("POST", "/auth/redeem", { token, password, device_id }),
    // Admins only. Every call needs the network; nothing here is stored on the device.
    users: () => request<{ users: AccountUser[] }>("GET", "/users"),
    /** `link` is this app's join page with TOKEN standing in for the token; the server fills it in. */
    invite: (name: string, email: string, role: string, link: string) =>
      request<LinkResult & { user_id: string }>("POST", "/users/invite", { name, email, role, link }),
    editUser: (userId: string, fields: { name?: string; email?: string }) =>
      request<{ user: User }>("POST", `/users/${userId}/edit`, fields),
    setRole: (userId: string, role: string) => request<{ user: User }>("POST", `/users/${userId}/role`, { role }),
    deactivate: (userId: string) => request<{ user: User }>("POST", `/users/${userId}/deactivate`),
    reactivate: (userId: string) => request<{ user: User }>("POST", `/users/${userId}/reactivate`),
    resetLink: (userId: string, link: string) => request<LinkResult>("POST", `/users/${userId}/reset-link`, { link }),
    devices: (userId: string) => request<{ devices: Device[] }>("GET", `/users/${userId}/devices`),
    revokeDevice: (userId: string, deviceId: string) =>
      request<{ devices: Device[] }>("POST", `/users/${userId}/devices/${deviceId}/revoke`),
    /** What the signed-in person hears about by email, and whether mail is set up to send it. */
    notifications: () => request<NotificationSettings>("GET", "/me/notifications"),
    saveNotifications: (categories: NotificationCategories) =>
      request<NotificationSettings>("PUT", "/me/notifications", categories),
    mail: () => request<{ mail: MailSettings | null }>("GET", "/mail"),
    saveMail: (settings: Omit<MailSettings, "has_password"> & { password: string }) =>
      request<{ mail: MailSettings }>("PUT", "/mail", settings),
    clearMail: () => request<{ mail: null }>("DELETE", "/mail"),
    /** To the signed-in Admin's own address, so a wrong password shows up now (FR-USR-16). */
    testMail: () => request<{ sent_to: string }>("POST", "/mail/test"),
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
    /** A PDF of fresh unassigned codes (FR-TAG-02). Admins only; the sheet is built on the server. */
    codeSheets: async (sheets: number): Promise<Blob> =>
      (await raw("POST", "/codes/sheets", JSON.stringify({ sheets }), "application/json")).blob(),
    /** Every live item as a spreadsheet (FR-RPT-03). Any signed-in person. */
    exportCsv: async (): Promise<Blob> => (await raw("GET", "/inventory.csv")).blob(),
    /** What an import would do, without doing it (FR-SET-11). Admins only. */
    previewImport: async (text: string): Promise<ImportPlan> =>
      (await raw("POST", "/inventory/import/preview", text, "text/csv")).json(),
    applyImport: async (text: string): Promise<ImportResult> =>
      (await raw("POST", "/inventory/import", text, "text/csv")).json(),
  };
}
