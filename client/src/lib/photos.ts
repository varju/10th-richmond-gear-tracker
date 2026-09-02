/**
 * Photos on an item or a ticket (FR-INV-11, FR-REP-01). The bytes never live
 * in the offline copy: one taken with no signal waits in its own store and goes
 * up at the next sync; the server then records photo_added, and the event comes
 * back with the rest of the log. Viewing one always needs a connection.
 */
import { type Api, Offline, PHOTO_TYPES } from "./api";
import type { EntityRef } from "./notes";
import type { Photo, State } from "./replay";
import type { QueuedPhoto, Store } from "./store";
import { newUlid } from "./ulid";

/** Longest side after shrinking. A phone photo is 4000 px and 3 MB; this is 1600 px and about 300 KB. */
export const MAX_SIDE = 1600;
export const JPEG_QUALITY = 0.8;

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

/** What the server has for this entity, oldest first. */
export function photosOf(state: State, on: EntityRef): Photo[] {
  return ((state[on.entity_type]?.[on.entity_id]?.photos ?? []) as Photo[]).slice();
}

/**
 * Shrink with a canvas when the browser has one. A test runtime does not, and
 * a browser that cannot decode the file should not lose it: either way the
 * blob is kept as it came.
 */
export async function shrink(file: Blob, maxSide: number = MAX_SIDE): Promise<{ blob: Blob; contentType: string }> {
  const asIs = { blob: file, contentType: file.type || "image/jpeg" };
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return asIs;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return asIs;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return blob ? { blob, contentType: "image/jpeg" } : asIs;
  } catch {
    return asIs;
  }
}

/** Keep a photo on this device until the server has it. Answers the id it will have. */
export async function queuePhoto(store: Store, on: EntityRef, file: Blob): Promise<string> {
  actor(store);
  if (!store.state[on.entity_type]?.[on.entity_id]) throw new Error(`no such ${on.entity_type}`);
  const { blob, contentType } = await shrink(file);
  if (!PHOTO_TYPES.includes(contentType)) throw new Error("That is not a photo the app can keep. Use a JPEG or PNG.");
  const created_at = store.now();
  const id = newUlid(created_at);
  await store.queuePhoto({
    id,
    entity_type: on.entity_type,
    entity_id: on.entity_id,
    bytes: await blob.arrayBuffer(),
    content_type: contentType,
    created_at,
  });
  return id;
}

/** What is still waiting to go up, for everything or for one entity. */
export async function pendingPhotos(store: Store, on?: EntityRef): Promise<QueuedPhoto[]> {
  const all = await store.queuedPhotos();
  return on ? all.filter((p) => p.entity_type === on.entity_type && p.entity_id === on.entity_id) : all;
}

/**
 * Send what is waiting, oldest first. Stops quietly at the first sign of no
 * network; the rest waits for the next sync. A refusal drops the photo, since
 * sending it again would get the same answer, and says why.
 */
export async function uploadPhotos(store: Store, api: Api): Promise<number> {
  let sent = 0;
  for (const photo of await store.queuedPhotos()) {
    try {
      const blob = new Blob([photo.bytes], { type: photo.content_type });
      await api.uploadPhoto(photo.id, photo.entity_type, photo.entity_id, blob, photo.content_type);
    } catch (error) {
      if (error instanceof Offline) return sent;
      console.warn(`photo ${photo.id} refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    await store.dropQueuedPhoto(photo.id);
    sent++;
  }
  return sent;
}

/** Hide it. The event goes on the log like any other; the file stays on the server. */
export async function removePhoto(store: Store, on: EntityRef, photoId: string): Promise<void> {
  if (!photosOf(store.state, on).some((p) => p.id === photoId)) throw new Error("no such photo");
  await store.record({ ...on, type: "photo_removed", actor_id: actor(store), payload: { photo_id: photoId } });
}
