/**
 * Everything this device knows, in memory and in IndexedDB.
 *
 * The data is a snapshot plus the events after it (FR-OFF-14). State is
 * replayed from those on every change; 500 items make that cheap. IndexedDB is
 * written through on change and read once, here in open() (see architecture.md,
 * "In memory").
 */
import type { OutgoingEvent, ServerEvent, User } from "./api";
import { RETENTION_MS } from "./clock";
import { done, req } from "./db";
import { type Fields, KNOWN_EVENT_TYPES, replay, type ReplayEvent, replayOrder, type State } from "./replay";
import { newUlid } from "./ulid";

/** no: waiting to push. yes: the server has it. rejected: the server refused it; kept for the record, not replayed. */
export type Sent = "no" | "yes" | "rejected";

export interface StoredEvent extends ReplayEvent {
  occurred_at: number;
  clock_offset: number;
  sent: Sent;
  seq?: number;
  received_at?: number;
  reason?: string;
}

export interface Meta {
  device_id: string;
  device_seq: number;
  clock_offset: number;
  cursor?: number;
  /** The log the snapshot and cursor came from. A cursor without one predates this field and cannot be trusted. */
  log_id?: string;
  /** The event name scans are for, until changed or cleared (FR-OUT-05). A device setting, not a record. */
  session_event?: string;
  token?: string;
  user?: User;
  last_sync_at?: number;
  /** A stock check in progress (FR-RPT-09). Where the person is, and what they have scanned there. */
  stock_check?: StockCheck;
  /** The categories the last new item took, so a run of tents costs no taps. A device setting, not a record. */
  last_category_ids?: string[];
}

export interface StockCheck {
  location_id: string;
  sub_location?: string;
  seen: string[];
  started_at: number;
}

/** A photo taken here and not yet on the server (FR-INV-11). These bytes are the only copy until then. */
export interface QueuedPhoto {
  id: string;
  entity_type: string;
  entity_id: string;
  /** Plain bytes, not a Blob: every IndexedDB stores these the same way. */
  bytes: ArrayBuffer;
  content_type: string;
  created_at: number;
}

export interface Recording {
  entity_type: string;
  entity_id: string;
  type: string;
  actor_id: string;
  payload: Record<string, unknown>;
}

const SNAPSHOT_KEY = "snapshot";

/** The server's wording for a reused device_seq (events.py, `append`). Pulls out the last one it saw. */
const SEQ_COLLISION = /^device_seq \d+ is not above the last seen, (\d+)$/;

function seqCollision(reason: string): number | undefined {
  const match = SEQ_COLLISION.exec(reason);
  return match ? Number(match[1]) : undefined;
}

export class Store {
  state: State = {};
  /** Bumped on every change, for useSyncExternalStore. */
  version = 0;
  private listeners = new Set<() => void>();
  private events = new Map<string, StoredEvent>();

  private constructor(
    private db: IDBDatabase,
    public meta: Meta,
    private snapshot: State,
    /** The clock every record is stamped with. Tests hand in their own. */
    readonly now: () => number,
  ) {}

  static async open(db: IDBDatabase, now: () => number = Date.now): Promise<Store> {
    const tx = db.transaction(["meta", "events"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const [keys, values, events] = await Promise.all([
      req(metaStore.getAllKeys()),
      req(metaStore.getAll()),
      req(tx.objectStore("events").getAll() as IDBRequest<StoredEvent[]>),
    ]);
    const raw = Object.fromEntries(keys.map((k, i) => [k as string, values[i]])) as Partial<Meta> & {
      snapshot?: State;
    };
    const { snapshot = {}, ...rest } = raw;
    const meta: Meta = { device_id: newUlid(now()), device_seq: 0, clock_offset: 0, ...rest };
    if (!raw.device_id) metaStore.put(meta.device_id, "device_id");
    await done(tx);

    const store = new Store(db, meta, snapshot, now);
    for (const event of events) store.events.set(event.id, event);
    store.recompute();
    return store;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Events recorded here that the server has not confirmed, oldest first. */
  get pending(): StoredEvent[] {
    return [...this.events.values()].filter((e) => e.sent === "no").sort((a, b) => a.device_seq - b.device_seq);
  }

  /** Events the server refused, most recent first (Settings, "records the server refused"). */
  get rejected(): StoredEvent[] {
    return [...this.events.values()].filter((e) => e.sent === "rejected").sort((a, b) => b.occurred_at - a.occurred_at);
  }

  get items(): Record<string, Fields> {
    return this.state.item ?? {};
  }

  /** What this device knows happened to one entity, in replay order. History, not state: the last 90 days at most. */
  eventsFor(entity_type: string, entity_id: string): StoredEvent[] {
    return [...this.events.values()]
      .filter((e) => e.entity_type === entity_type && e.entity_id === entity_id && e.sent !== "rejected")
      .sort(replayOrder);
  }

  async setMeta(patch: Partial<Meta>): Promise<void> {
    // A non-finite offset - including undefined, from a response with no server_time to measure
    // against (see api.ts, `request`) - is never stored: it would poison every effective_at
    // computed after it. clock_offset is not optional on Meta, so this also stops `undefined`
    // from being treated as "delete the key" further down, which would leave it missing instead.
    if ("clock_offset" in patch && !Number.isFinite(patch.clock_offset)) patch = { ...patch, clock_offset: 0 };
    const tx = this.db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) store.delete(key);
      else store.put(value, key);
    }
    await done(tx);
    Object.assign(this.meta, patch);
    for (const key of Object.keys(patch) as (keyof Meta)[]) {
      if (patch[key] === undefined) delete this.meta[key];
    }
    this.notify();
  }

  /**
   * Record something that happened here. Stamped with the current clock offset (NFR-DATA-13).
   *
   * The sequence number is read from IndexedDB inside this transaction, not from the in-memory
   * copy: two tabs on the same device share one database, and reading from memory let them hand
   * out the same number, which the server then refused as a duplicate (docs/tasks.md, "Sync").
   */
  async record(input: Recording): Promise<StoredEvent> {
    const occurred_at = this.now();
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const stored = (await req(metaStore.get("device_seq"))) as number | undefined;
    const device_seq = (stored ?? this.meta.device_seq) + 1;
    const event: StoredEvent = {
      ...input,
      id: newUlid(occurred_at),
      device_id: this.meta.device_id,
      device_seq,
      occurred_at,
      clock_offset: this.meta.clock_offset,
      effective_at: occurred_at + this.meta.clock_offset,
      sent: "no",
    };
    tx.objectStore("events").put(event);
    metaStore.put(device_seq, "device_seq");
    await done(tx);
    this.meta.device_seq = device_seq;
    this.events.set(event.id, event);
    this.recompute();
    return event;
  }

  /** What to send: the fields the server validates, nothing it assigns. */
  static outgoing(event: StoredEvent): OutgoingEvent {
    const { id, entity_type, entity_id, type, actor_id, device_id, device_seq, occurred_at, clock_offset, payload } =
      event;
    return { id, entity_type, entity_id, type, actor_id, device_id, device_seq, occurred_at, clock_offset, payload };
  }

  /**
   * The server's answer to a push. Unsent events stay unsent if they were not mentioned.
   *
   * A rejection for reusing a sequence number is not this device's fault (two tabs racing, or
   * data left over from before that bug was fixed): it is not marked rejected. Instead every
   * event still unsent is re-stamped with a fresh number and `retry` comes back true, so the
   * caller can push once more.
   */
  async pushed(accepted: string[], rejected: { id: string | null; reason: string }[]): Promise<{ retry: boolean }> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    let lastSeen: number | undefined;
    for (const id of accepted) this.mark(store, id, { sent: "yes" });
    for (const { id, reason } of rejected) {
      const seen = seqCollision(reason);
      if (seen !== undefined) {
        lastSeen = lastSeen === undefined ? seen : Math.max(lastSeen, seen);
        continue;
      }
      if (id) this.mark(store, id, { sent: "rejected", reason });
    }
    await done(tx);
    this.recompute();
    if (lastSeen === undefined) return { retry: false };
    await this.restamp(lastSeen);
    return { retry: true };
  }

  /** Give every unsent event a fresh device_seq, above both `minimum` and the stored counter. */
  private async restamp(minimum: number): Promise<void> {
    const pending = this.pending;
    if (pending.length === 0) return;
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const stored = (await req(metaStore.get("device_seq"))) as number | undefined;
    let seq = Math.max(minimum, stored ?? 0, this.meta.device_seq);
    const events = tx.objectStore("events");
    for (const event of pending) {
      seq += 1;
      const updated = { ...event, device_seq: seq };
      this.events.set(event.id, updated);
      events.put(updated);
    }
    metaStore.put(seq, "device_seq");
    await done(tx);
    this.meta.device_seq = seq;
    this.recompute();
  }

  /** Remove a record the server refused (Settings, "records the server refused"). */
  async discard(id: string): Promise<void> {
    const tx = this.db.transaction("events", "readwrite");
    tx.objectStore("events").delete(id);
    await done(tx);
    this.events.delete(id);
    this.recompute();
  }

  private mark(store: IDBObjectStore, id: string, patch: Partial<StoredEvent>): void {
    const event = this.events.get(id);
    if (!event) return;
    const updated = { ...event, ...patch };
    this.events.set(id, updated);
    store.put(updated);
  }

  /**
   * Start over from a snapshot (FR-OFF-14). Unsent work survives and is replayed on top.
   *
   * The snapshot, its cursor, and the log it came from are one fact and are written in one
   * transaction: split across two, a kill between them could leave a fresh log_id over a stale
   * snapshot, and the guard that re-bootstraps a cursor with no log_id would never fire. `log_id`
   * is optional only so a test fixture with no server behind it can skip stating one.
   */
  async bootstrap(snapshot: State, cursor: number, log_id?: string): Promise<void> {
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const events = tx.objectStore("events");
    for (const event of this.events.values()) {
      if (event.sent === "yes") {
        events.delete(event.id);
        this.events.delete(event.id);
      }
    }
    const metaStore = tx.objectStore("meta");
    metaStore.put(snapshot, SNAPSHOT_KEY);
    metaStore.put(cursor, "cursor");
    if (log_id !== undefined) metaStore.put(log_id, "log_id");
    await done(tx);
    this.snapshot = snapshot;
    this.meta.cursor = cursor;
    if (log_id !== undefined) this.meta.log_id = log_id;
    this.recompute();
  }

  /** A page from pull. The server's copy of our own event replaces ours: it has the clamped time and a seq. */
  async receive(events: ServerEvent[], cursor: number): Promise<void> {
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const store = tx.objectStore("events");
    for (const event of events) {
      const stored: StoredEvent = { ...event, sent: "yes" };
      this.events.set(event.id, stored);
      store.put(stored);
    }
    tx.objectStore("meta").put(cursor, "cursor");
    await done(tx);
    this.meta.cursor = cursor;
    this.recompute();
  }

  /**
   * Fold history older than the retention window into the snapshot (NFR-DATA-03).
   * Only events the server has assigned a seq are folded; unsent work is never trimmed.
   * Returns how many events were folded.
   */
  async trim(now: number = this.now()): Promise<number> {
    const cutoff = now - RETENTION_MS;
    // An event of a type this build does not know is left alone rather than folded: folding it
    // would replay it (recompute does the same skip) and then delete the only copy, so a build
    // that does know the type would never see it.
    const old = [...this.events.values()].filter(
      (e) => e.seq !== undefined && e.effective_at < cutoff && KNOWN_EVENT_TYPES.has(e.type),
    );
    if (old.length === 0) return 0;
    const snapshot = replay(old, this.snapshot);
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const events = tx.objectStore("events");
    for (const event of old) {
      events.delete(event.id);
      this.events.delete(event.id);
    }
    tx.objectStore("meta").put(snapshot, SNAPSHOT_KEY);
    await done(tx);
    this.snapshot = snapshot;
    this.recompute();
    return old.length;
  }

  // --- photos waiting to upload -------------------------------------------------------

  async queuePhoto(photo: QueuedPhoto): Promise<void> {
    const tx = this.db.transaction("photos", "readwrite");
    tx.objectStore("photos").put(photo);
    await done(tx);
    this.notify();
  }

  /** Oldest first, so uploads land in the order they were taken. */
  async queuedPhotos(): Promise<QueuedPhoto[]> {
    const tx = this.db.transaction("photos", "readonly");
    const all = await req(tx.objectStore("photos").getAll() as IDBRequest<QueuedPhoto[]>);
    return all.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  }

  async dropQueuedPhoto(id: string): Promise<void> {
    const tx = this.db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(id);
    await done(tx);
    this.notify();
  }

  private recompute(): void {
    const live = [...this.events.values()].filter((e) => e.sent !== "rejected");
    // A future build may write a type this one does not know (the PWA precaches its shell, so an
    // old build can pull events from a newer server). Skip those rather than throw: they stay
    // stored, unapplied, until a build that knows them opens the store (FR-OFF-14).
    const known: ReplayEvent[] = [];
    let skipped = 0;
    for (const event of live) {
      if (KNOWN_EVENT_TYPES.has(event.type)) known.push(event);
      else skipped++;
    }
    if (skipped > 0) console.warn(`recompute: skipped ${skipped} event(s) of a type this build does not know`);
    this.state = replay(known, this.snapshot);
    this.notify();
  }

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
