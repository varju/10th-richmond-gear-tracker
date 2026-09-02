import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { ApiError, Offline } from "../lib/api";
import type { EntityRef } from "../lib/notes";
import { pendingPhotos, photosOf, queuePhoto, removePhoto } from "../lib/photos";
import type { Photo } from "../lib/replay";
import type { QueuedPhoto, Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";

/** Bytes already fetched this session, so a re-render is not a re-download. Never written to disk (FR-INV-11). */
const seen = new Map<string, string>();

/**
 * The photos on an item or a ticket (FR-INV-11, FR-REP-01). Thumbnails are
 * fetched when online and shown from memory. Offline, the count is all there
 * is. A new photo waits on this device and goes up at the next sync.
 */
export function Photos({ store, on }: { store: Store; on: EntityRef }) {
  useStore(store);
  const shell = useShell();
  const photos = photosOf(store.state, on);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [offline, setOffline] = useState(false);
  const [waiting, setWaiting] = useState<QueuedPhoto[]>([]);
  const [open, setOpen] = useState<Photo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ids = photos.map((p) => p.id).join(",");

  useEffect(() => {
    let cancelled = false;
    void pendingPhotos(store, on).then((q) => !cancelled && setWaiting(q));
    return () => {
      cancelled = true;
    };
  }, [store, on.entity_type, on.entity_id, store.version]);

  useEffect(() => {
    const api = shell.api;
    if (!api) return;
    let cancelled = false;
    (async () => {
      for (const id of ids.split(",").filter(Boolean)) {
        if (seen.has(id)) continue;
        try {
          const blob = await api.fetchPhoto(id);
          seen.set(id, URL.createObjectURL(blob));
        } catch (e) {
          if (e instanceof Offline) {
            if (!cancelled) setOffline(true);
            return;
          }
          if (e instanceof ApiError && e.status === 404) continue;
          throw e;
        }
      }
      if (!cancelled) {
        setOffline(false);
        setUrls(Object.fromEntries([...seen]));
      }
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not load photos"));
    return () => {
      cancelled = true;
    };
  }, [shell.api, ids]);

  async function add(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      await queuePhoto(store, on, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not keep the photo");
      return;
    }
    void shell.sync();
  }

  async function remove(photo: Photo) {
    setError(null);
    try {
      await removePhoto(store, on, photo.id);
      setOpen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the photo");
    }
  }

  const shown = photos.filter((p) => urls[p.id]);
  const unseen = photos.length - shown.length;

  return (
    <div className="photos">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="photo-strip" aria-label="Photos">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className="photo-thumb" onClick={() => setOpen(p)} aria-label="View photo">
                <img src={urls[p.id]} alt="" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {unseen > 0 && (
        <p className="muted small">
          {plural(unseen, "photo")}
          {offline || !shell.api ? " · need a connection to view" : " · loading"}
        </p>
      )}
      {waiting.length > 0 && <p className="muted small">{plural(waiting.length, "photo")} waiting to upload</p>}
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Photo file"
        hidden
        onChange={add}
      />
      <button type="button" className="minor" onClick={() => input.current?.click()}>
        Add photo
      </button>
      {open && (
        <div className="photo-view" role="dialog" aria-label="Photo">
          <img src={urls[open.id]} alt="" />
          <div className="row">
            <RemoveButton onRemove={() => remove(open)} />
            <button type="button" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Two taps, like Retire: the first asks. */
function RemoveButton({ onRemove }: { onRemove: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <button type="button" className={asking ? "warn" : ""} onClick={() => (asking ? onRemove() : setAsking(true))}>
      {asking ? "Really remove?" : "Remove"}
    </button>
  );
}
