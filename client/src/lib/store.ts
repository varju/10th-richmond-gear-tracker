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
import { type Fields, replay, type ReplayEvent, replayOrder, type State } from "./replay";
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
  /** The event name scans are for, until changed or cleared (FR-OUT-05). A device setting, not a record. */
  session_event?: string;
  token?: string;
  user?: User;
  last_sync_at?: number;
}

export interface Recording {
  entity_type: string;
  entity_id: string;
  type: string;
  actor_id: string;
  payload: Record<string, unknown>;
}

const SNAPSHOT_KEY = "snapshot";

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
    private now: () => number,
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

  /** Record something that happened here. Stamped with the current clock offset (NFR-DATA-13). */
  async record(input: Recording): Promise<StoredEvent> {
    const occurred_at = this.now();
    const event: StoredEvent = {
      ...input,
      id: newUlid(occurred_at),
      device_id: this.meta.device_id,
      device_seq: this.meta.device_seq + 1,
      occurred_at,
      clock_offset: this.meta.clock_offset,
      effective_at: occurred_at + this.meta.clock_offset,
      sent: "no",
    };
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    tx.objectStore("events").put(event);
    tx.objectStore("meta").put(event.device_seq, "device_seq");
    await done(tx);
    this.meta.device_seq = event.device_seq;
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

  /** The server's answer to a push. Unsent events stay unsent if they were not mentioned. */
  async pushed(accepted: string[], rejected: { id: string | null; reason: string }[]): Promise<void> {
    const tx = this.db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    for (const id of accepted) this.mark(store, id, { sent: "yes" });
    for (const { id, reason } of rejected) if (id) this.mark(store, id, { sent: "rejected", reason });
    await done(tx);
    this.recompute();
  }

  private mark(store: IDBObjectStore, id: string, patch: Partial<StoredEvent>): void {
    const event = this.events.get(id);
    if (!event) return;
    const updated = { ...event, ...patch };
    this.events.set(id, updated);
    store.put(updated);
  }

  /** Start over from a snapshot (FR-OFF-14). Unsent work survives and is replayed on top. */
  async bootstrap(snapshot: State, cursor: number): Promise<void> {
    const tx = this.db.transaction(["meta", "events"], "readwrite");
    const events = tx.objectStore("events");
    for (const event of this.events.values()) {
      if (event.sent === "yes") {
        events.delete(event.id);
        this.events.delete(event.id);
      }
    }
    tx.objectStore("meta").put(snapshot, SNAPSHOT_KEY);
    tx.objectStore("meta").put(cursor, "cursor");
    await done(tx);
    this.snapshot = snapshot;
    this.meta.cursor = cursor;
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
    const old = [...this.events.values()].filter((e) => e.seq !== undefined && e.effective_at < cutoff);
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

  private recompute(): void {
    const live = [...this.events.values()].filter((e) => e.sent !== "rejected");
    this.state = replay(live, this.snapshot);
    this.notify();
  }

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
