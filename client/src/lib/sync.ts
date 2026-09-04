/**
 * One sync: push what is waiting, then catch up. Called on app open, on
 * regaining connectivity, and after every movement (FR-OFF-03).
 *
 * Push comes first so a deactivated account's last work lands before the
 * server refuses it (FR-OFF-06). Every response re-measures the clock offset
 * (NFR-DATA-13) and its round trip; the round trip is sent back with the next
 * push so the server can allow for latency in its own measurement.
 */
import { type Api, ApiError, Offline } from "./api";
import { uploadPhotos } from "./photos";
import { Store } from "./store";

export type SyncOutcome = { ok: true } | { ok: false; reason: "offline" | "signed_out" | "error"; message: string };

export async function sync(store: Store, api: Api, now: () => number = Date.now): Promise<SyncOutcome> {
  if (!store.meta.token) return { ok: false, reason: "signed_out", message: "not signed in" };
  try {
    const pending = store.pending;
    let unidentified = 0;
    // A log_id on this push's reply that differs from ours means the server's database was
    // replaced since we last synced: our cursor is meaningless there, whatever it says.
    let replaced = false;
    const stampRoundTrip = (offset: number | undefined, round_trip: number) =>
      store.setMeta({ round_trip_ms: round_trip, ...(offset !== undefined ? { clock_offset: offset } : {}) });
    if (pending.length > 0) {
      const { data, offset, round_trip } = await api.push(
        store.meta.device_id,
        now(),
        pending.map((e) => Store.outgoing(e)),
        store.meta.round_trip_ms,
      );
      await stampRoundTrip(offset, round_trip);
      if (store.meta.log_id !== undefined && data.log_id !== store.meta.log_id) replaced = true;
      const pushed = await store.pushed(data.accepted, data.rejected);
      unidentified += pushed.unidentified;
      // A sequence collision (two tabs, or old data from before it was fixed) is not a real
      // rejection: the affected events were re-stamped and are ready to go up again, once.
      if (pushed.retry && store.pending.length > 0) {
        const {
          data: retried,
          offset: retriedOffset,
          round_trip: retriedRoundTrip,
        } = await api.push(
          store.meta.device_id,
          now(),
          store.pending.map((e) => Store.outgoing(e)),
          store.meta.round_trip_ms,
        );
        await stampRoundTrip(retriedOffset, retriedRoundTrip);
        if (!replaced && store.meta.log_id !== undefined && retried.log_id !== store.meta.log_id) replaced = true;
        const retriedPushed = await store.pushed(retried.accepted, retried.rejected);
        unidentified += retriedPushed.unidentified;
      }
    }
    // Photos taken offline go up now, before pull brings back the events that name them (FR-INV-11).
    await uploadPhotos(store, api);

    // A cursor with no log_id was stored by an older build of this app. It may
    // belong to a database that has since been replaced, so it is not trusted.
    if (replaced || store.meta.cursor === undefined || store.meta.log_id === undefined) {
      await bootstrap(store, api);
    } else {
      try {
        await pull(store, api);
      } catch (error) {
        // Our cursor means nothing to this server any more: too old, or the
        // database was restored. Start again from a snapshot (FR-OFF-14).
        if (error instanceof ApiError && error.status === 410) await bootstrap(store, api);
        else throw error;
      }
    }

    await store.setMeta({ last_sync_at: now() });
    await store.trim(now());
    // The rest of sync still ran — the device is not stuck — but the server could not match some
    // rejections to anything it holds, so report the batch as unclean rather than as a full success.
    if (unidentified > 0) {
      return {
        ok: false,
        reason: "error",
        message: `the server refused ${unidentified} record(s) it could not identify`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Offline) return { ok: false, reason: "offline", message: error.message };
    if (error instanceof ApiError) {
      if (error.round_trip !== undefined || error.offset !== undefined) {
        await store.setMeta({
          ...(error.round_trip !== undefined ? { round_trip_ms: error.round_trip } : {}),
          ...(error.offset !== undefined ? { clock_offset: error.offset } : {}),
        });
      }
      if (error.status === 401 || error.code === "deactivated") {
        await store.setMeta({ token: undefined, user: undefined });
        return { ok: false, reason: "signed_out", message: error.message };
      }
      return { ok: false, reason: "error", message: error.message };
    }
    throw error;
  }
}

async function bootstrap(store: Store, api: Api): Promise<void> {
  const { data, offset, round_trip } = await api.bootstrap();
  // The snapshot, cursor and log_id all belong together (see Store.bootstrap); the offset and
  // round trip are only a convenience and are set separately, and only when the server gave us
  // an offset to use.
  await store.bootstrap(data.snapshot, data.cursor, data.log_id);
  await store.setMeta({
    round_trip_ms: round_trip,
    ...(offset !== undefined ? { clock_offset: offset } : {}),
    // The current upcoming-events list, so it works offline too (FR-RES-20). Not part of the
    // snapshot: the server owns it and replaces it whole, there is no history to replay.
    calendar_events: data.calendar_events,
  });
}

/** The device calls again until it gets an empty page. */
async function pull(store: Store, api: Api): Promise<void> {
  for (;;) {
    const since = store.meta.cursor ?? 0;
    const { data, offset, round_trip } = await api.pull(since, store.meta.log_id);
    await store.setMeta({
      round_trip_ms: round_trip,
      ...(offset !== undefined ? { clock_offset: offset } : {}),
      calendar_events: data.calendar_events,
    });
    // A non-empty page must move the cursor past where we asked from; one that does not is a
    // server bug, not something a retry fixes, so this stops the loop instead of spinning forever.
    if (data.events.length > 0 && data.cursor <= since) {
      throw new Error(`pull returned events but the cursor did not advance past ${since} (got ${data.cursor})`);
    }
    await store.receive(data.events, data.cursor);
    if (data.events.length === 0) return;
  }
}
