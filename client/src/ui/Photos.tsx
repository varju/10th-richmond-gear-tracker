import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { ApiError, Offline } from "../lib/api";
import type { EntityRef } from "../lib/notes";
import { pendingPhotos, photosOf, queuePhoto, removePhoto } from "../lib/photos";
import type { Photo } from "../lib/replay";
import { NATIVE } from "../lib/server";
import type { QueuedPhoto, Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { ConfirmButton } from "./ConfirmButton";
import { plural } from "./labels";

/** Bytes already fetched this session, so a re-render is not a re-download. Never written to disk (FR-INV-11). */
const seen = new Map<string, string>();

/** Stops the browser opening a file dropped on a screen that takes no photo. */
export function useBlockFileDrop(active: boolean) {
  useEffect(() => {
    if (!active || NATIVE) return;
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    return () => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    };
  }, [active]);
}

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
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const viewing = useRef(false);
  viewing.current = open !== null;
  const ids = photos.map((p) => p.id).join(",");

  useEffect(() => {
    let cancelled = false;
    void pendingPhotos(store, on).then((q) => !cancelled && setWaiting(q));
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
        setUrls(Object.fromEntries(seen));
      }
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not load photos"));
    return () => {
      cancelled = true;
    };
  }, [shell.api, ids]);

  async function keep(files: File[]) {
    setError(null);
    let kept = 0;
    let failure: string | null = null;
    for (const file of files) {
      try {
        await queuePhoto(store, on, file);
        kept++;
      } catch (err) {
        failure ??= err instanceof Error ? err.message : "Could not keep the photo";
      }
    }
    if (failure) setError(failure);
    if (kept > 0) void shell.sync();
  }
  const keepRef = useRef(keep);
  keepRef.current = keep;

  useEffect(() => {
    if (NATIVE) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || viewing.current) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (viewing.current) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return setError("Only photos can be dropped here");
      void keepRef.current(images);
      const skipped = files.length - images.length;
      if (skipped > 0) setError(`${plural(skipped, "file")} skipped: not a photo`);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, []);

  async function add(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await keep([file]);
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
      {dragging && (
        <div className="photo-drop" aria-hidden="true">
          Drop to add a photo
        </div>
      )}
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
            <ConfirmButton label="Remove" confirmLabel="Really remove?" onConfirm={() => remove(open)} />
            <button type="button" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
