/**
 * One sync: push what is waiting, then catch up. Called on app open, on
 * regaining connectivity, and after every movement (FR-OFF-03).
 *
 * Push comes first so a deactivated account's last work lands before the
 * server refuses it (FR-OFF-06). Every response re-measures the clock offset
 * (NFR-DATA-13).
 */
import { type Api, ApiError, Offline } from "./api";
import { uploadPhotos } from "./photos";
import { Store } from "./store";

export type SyncOutcome = { ok: true } | { ok: false; reason: "offline" | "signed_out" | "error"; message: string };

export async function sync(store: Store, api: Api, now: () => number = Date.now): Promise<SyncOutcome> {
  if (!store.meta.token) return { ok: false, reason: "signed_out", message: "not signed in" };
  try {
    const pending = store.pending;
    if (pending.length > 0) {
      const { data, offset } = await api.push(
        store.meta.device_id,
        now(),
        pending.map((e) => Store.outgoing(e)),
      );
      await store.setMeta({ clock_offset: offset });
      await store.pushed(data.accepted, data.rejected);
    }
    // Photos taken offline go up now, before pull brings back the events that name them (FR-INV-11).
    await uploadPhotos(store, api);

    if (store.meta.cursor === undefined) {
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
    return { ok: true };
  } catch (error) {
    if (error instanceof Offline) return { ok: false, reason: "offline", message: error.message };
    if (error instanceof ApiError) {
      if (error.offset !== undefined) await store.setMeta({ clock_offset: error.offset });
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
  const { data, offset } = await api.bootstrap();
  await store.setMeta({ clock_offset: offset });
  await store.bootstrap(data.snapshot, data.cursor);
}

/** The device calls again until it gets an empty page. */
async function pull(store: Store, api: Api): Promise<void> {
  for (;;) {
    const { data, offset } = await api.pull(store.meta.cursor ?? 0);
    await store.setMeta({ clock_offset: offset });
    await store.receive(data.events, data.cursor);
    if (data.events.length === 0) return;
  }
}
